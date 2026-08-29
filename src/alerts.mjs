// Phone alert delivery. config.alerts.transport is the preferred transport;
// the other transport is available as fallback.

import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  markFcmRegistrationSuspect,
  readAlertRuntime,
  readFcmRegistration,
  recordTransportFailure,
  recordTransportSuccess,
  requestWebSocket,
} from "./alert-runtime.mjs";
import { resolveFcmConfig } from "./fcm-config.mjs";
import { publishWorkerEvent, workerEnabled } from "./worker-control.mjs";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const truncate = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function failoverSettings(config, transport) {
  const f = config?.alerts?.failover || {};
  const perTransport = f?.[transport] || {};
  return {
    failureLimit: Math.max(1, Number(perTransport.failureLimit ?? f.failureLimit ?? 3) || 3),
    wsActivationDelayMs: Math.max(0, Number(f.websocketActivationDelayMs ?? 1500) || 0),
  };
}

function otherTransport(transport) {
  return transport === "fcm" ? "websocket" : "fcm";
}

function errorSummary(error) {
  return String(error?.message || error || "unknown error").slice(0, 500);
}

/**
 * Send one alert. Each alert gets one primary attempt; if it fails, the
 * alternate transport is attempted for that alert. Consecutive primary
 * failures separately decide when the delivery state enters fallback.
 */
export async function sendAlert(payload, config) {
  const a = config?.alerts || {};
  const primary = a.transport || "websocket";
  if (!["websocket", "fcm"].includes(primary)) {
    throw new Error(`unknown alerts.transport: "${primary}" (expected "websocket" or "fcm")`);
  }

  const secondary = otherTransport(primary);
  const alertId = payload.alertId || randomUUID();
  const body = {
    kind: "alert",
    alertId,
    chat: String(payload.chat ?? ""),
    author: String(payload.author ?? ""),
    text: truncate(payload.text),
    time: payload.time || null,
    primaryTransport: primary,
  };
  const attempts = [];

  const primaryResult = await attempt(primary, body, config).catch((error) => ({ error }));
  if (!primaryResult.error) {
    await recordTransportSuccess(primary, primary);
    attempts.push({ transport: primary, ok: true, ...primaryResult });
    return { alertId, transport: primary, attempts };
  }

  const primaryError = primaryResult.error;
  const classification = classifyFailure(primary, primaryError);
  const { failureLimit, wsActivationDelayMs } = failoverSettings(config, primary);
  let runtime;

  if (primary === "fcm" && classification.registrationInvalid) {
    runtime = await markFcmRegistrationSuspect(primary, classification.code || "fcm_registration_invalid");
  } else {
    runtime = await recordTransportFailure(primary, primary, {
      error: errorSummary(primaryError),
      nonRetryable: classification.nonRetryable,
      failureLimit,
    });
  }
  attempts.push({
    transport: primary,
    ok: false,
    error: errorSummary(primaryError),
    code: classification.code || null,
  });

  // WebSocket is cold standby when FCM is primary. Request it even before the
  // global failure limit so this specific alert can try the alternate path.
  if (primary === "fcm") {
    await requestWebSocket(primary, classification.registrationInvalid ? "fcm_registration_invalid" : "fcm_alert_failed");
    publishWorkerEvent(config, {
      type: classification.registrationInvalid ? "fcm_registration_invalid" : "fcm_delivery_failed",
      actions: classification.registrationInvalid
        ? ["ensure_fcm_registration", "start_ws"]
        : ["start_ws"],
      error: errorSummary(primaryError),
    }).catch(() => {});
  }

  let secondaryResult = await attempt(secondary, body, config).catch((error) => ({ error }));

  // If the Worker just asked the phone to start cold-standby WS, give it one
  // short chance to connect before declaring this alert undeliverable.
  if (
    secondary === "websocket" &&
    secondaryResult.error?.code === "NO_WS_CLIENTS" &&
    workerEnabled(config) &&
    wsActivationDelayMs > 0
  ) {
    await sleep(wsActivationDelayMs);
    secondaryResult = await attempt(secondary, body, config).catch((error) => ({ error }));
  }

  if (!secondaryResult.error) {
    await recordTransportSuccess(secondary, primary);
    attempts.push({ transport: secondary, ok: true, ...secondaryResult });
    return {
      alertId,
      transport: secondary,
      fallback: true,
      deliveryState: runtime?.delivery?.state || "primary_retrying",
      attempts,
    };
  }

  const secondaryError = secondaryResult.error;
  const secondarySettings = failoverSettings(config, secondary);
  await recordTransportFailure(secondary, primary, {
    error: errorSummary(secondaryError),
    nonRetryable: classifyFailure(secondary, secondaryError).nonRetryable,
    failureLimit: secondarySettings.failureLimit,
  });
  attempts.push({ transport: secondary, ok: false, error: errorSummary(secondaryError) });

  const error = new Error(
    `alert delivery failed on ${primary} (${errorSummary(primaryError)}) and ${secondary} (${errorSummary(secondaryError)})`
  );
  error.attempts = attempts;
  error.alertId = alertId;
  throw error;
}

async function attempt(transport, body, config) {
  const a = config?.alerts || {};
  const runtime = await readAlertRuntime(a.transport || "websocket");
  if (transport === "websocket") return await sendViaGuiHub(body, a, config);
  if (transport === "fcm") {
    return await sendViaFcm({
      ...body,
      websocketWanted: String((a.transport || "websocket") === "websocket" ? true : false),
      deliveryState: runtime.delivery.state,
    }, a.fcm || {});
  }
  throw new Error(`unknown transport: ${transport}`);
}

// ---- websocket (via the GUI server's hub) -----------------------------------

async function sendViaGuiHub(body, a, config) {
  const g = config?.gui || {};
  const host = g.host && g.host !== "0.0.0.0" && g.host !== "::" ? g.host : "127.0.0.1";
  const url = a.websocketUrl || `http://${host}:${g.port || 8090}/api/alerts`;
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"];
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`alert hub rejected: ${r.status} ${j.error || ""}`.trim()), { code: "WS_HUB_REJECTED" });
  const delivered = Number(j.delivered || 0);
  if (delivered < 1) {
    throw Object.assign(new Error("alert hub has no connected phone clients"), { code: "NO_WS_CLIENTS" });
  }
  return { delivered };
}

// ---- fcm --------------------------------------------------------------------

let cachedToken = null; // { accessToken, expMs }

async function fcmAccessToken(sa) {
  if (cachedToken && Date.now() < cachedToken.expMs - 60_000) return cachedToken.accessToken;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({ iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600 });
  const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw Object.assign(new Error(`FCM OAuth token exchange failed: ${r.status} ${await r.text()}`), { code: "FCM_AUTH" });
  const j = await r.json();
  cachedToken = { accessToken: j.access_token, expMs: Date.now() + j.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function sendViaFcm(body, fcm) {
  const resolved = await resolveFcmConfig(fcm);
  if (!resolved.serviceAccountValid) {
    const detail = resolved.serviceAccountPresent ? "invalid service account JSON" : "service account file missing";
    throw Object.assign(new Error(`alerts.fcm not configured — ${detail}: ${resolved.serviceAccountFile}`), { code: "FCM_CONFIG" });
  }
  if (!resolved.projectId) {
    throw Object.assign(new Error("alerts.fcm not configured — project ID missing from service account"), { code: "FCM_CONFIG" });
  }

  const registration = await readFcmRegistration();
  if (!registration) {
    throw Object.assign(
      new Error("FCM phone registration missing — open the Android app while a control path is reachable"),
      { code: "FCM_REGISTRATION_MISSING", registrationInvalid: true }
    );
  }

  const sa = resolved.serviceAccount;
  const accessToken = await fcmAccessToken(sa);
  const target = registration.kind === "fid"
    ? { fid: registration.value }
    : { token: registration.value };

  const data = {
    kind: "alert",
    alertId: String(body.alertId || ""),
    chat: body.chat,
    author: body.author,
    text: body.text,
    time: body.time || "",
    primaryTransport: String(body.primaryTransport || ""),
    websocketWanted: String(body.websocketWanted || "false"),
    deliveryState: String(body.deliveryState || ""),
  };

  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(resolved.projectId)}/messages:send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ message: { ...target, data, android: { priority: "HIGH" } } }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const status = String(j.error?.status || "");
    const e = new Error(`FCM send failed: ${r.status} ${status} ${j.error?.message || JSON.stringify(j)}`.trim());
    e.httpStatus = r.status;
    e.fcmStatus = status;
    e.code = status || `FCM_HTTP_${r.status}`;
    if (status === "UNREGISTERED" || r.status === 404) e.registrationInvalid = true;
    throw e;
  }
  return { messageId: j.name || null, registrationKind: registration.kind };
}

function classifyFailure(transport, error) {
  if (transport === "websocket") {
    return {
      code: error?.code || "WEBSOCKET_ERROR",
      nonRetryable: false,
      registrationInvalid: false,
    };
  }

  const status = String(error?.fcmStatus || error?.code || "");
  const http = Number(error?.httpStatus || 0);
  const registrationInvalid = !!error?.registrationInvalid || status === "UNREGISTERED" || http === 404;
  const nonRetryable = registrationInvalid || status === "FCM_CONFIG" || status === "FCM_AUTH";
  return { code: status || null, nonRetryable, registrationInvalid };
}
