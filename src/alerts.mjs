// Phone alert delivery. config.alerts.transport is the preferred transport;
// the other transport is available as fallback.

import { createSign, randomUUID } from "node:crypto";
import {
  markFcmRegistrationSuspect,
  readAlertRuntime,
  readFcmRegistration,
  recordFcmBackoff,
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

function fcmBackoffRemainingMs(runtime) {
  const at = Date.parse(runtime?.fcm?.nextAttemptAt || 0);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - Date.now());
}

/**
 * Send one alert.
 *
 * While the preferred transport is healthy/retrying, it gets the first attempt
 * and the alternate gets one per-alert fallback attempt on failure.
 *
 * Once the persisted delivery state is FALLBACK, the alternate gets the first
 * attempt. The preferred transport is then tried with the same alertId as a
 * recovery test; phone-side dedupe prevents a second alarm. One preferred-path
 * success returns the delivery state to PRIMARY_WORKING.
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

  const runtime = await readAlertRuntime(primary);
  if (runtime.delivery.state === "fallback") {
    return await sendWhileFallback(body, config, primary, secondary);
  }
  return await sendPrimaryFirst(body, config, primary, secondary);
}

async function sendPrimaryFirst(body, config, primary, secondary) {
  const attempts = [];
  const primaryResult = await attempt(primary, body, config).catch((error) => ({ error }));
  if (!primaryResult.error) {
    await recordTransportSuccess(primary, primary);
    attempts.push({ transport: primary, ok: true, ...primaryResult });
    return { alertId: body.alertId, transport: primary, attempts };
  }

  const primaryError = primaryResult.error;
  const primaryClassification = classifyFailure(primary, primaryError);
  const runtime = await recordPrimaryFailure(primary, primaryError, primaryClassification, config);
  attempts.push(failedAttempt(primary, primaryError, primaryClassification));

  if (secondary === "websocket") {
    await prepareWebSocketFallback(config, primaryClassification, primaryError);
  }

  const secondaryResult = await attemptFallbackTransport(secondary, body, config);
  if (!secondaryResult.error) {
    await recordTransportSuccess(secondary, primary);
    attempts.push({ transport: secondary, ok: true, ...secondaryResult });
    return {
      alertId: body.alertId,
      transport: secondary,
      fallback: true,
      deliveryState: runtime.delivery.state,
      attempts,
    };
  }

  const secondaryError = secondaryResult.error;
  await recordSecondaryFailure(secondary, primary, secondaryError, config);
  attempts.push(failedAttempt(secondary, secondaryError, classifyFailure(secondary, secondaryError)));
  throw deliveryError(body.alertId, attempts);
}

async function sendWhileFallback(body, config, primary, secondary) {
  const attempts = [];

  if (secondary === "websocket") {
    await prepareWebSocketFallback(config, { registrationInvalid: false }, null, "fallback_active");
  }

  const secondaryResult = await attemptFallbackTransport(secondary, body, config);
  if (!secondaryResult.error) {
    await recordTransportSuccess(secondary, primary);
    attempts.push({ transport: secondary, ok: true, ...secondaryResult });

    // The alert has a working delivery path now. Try the preferred path with
    // the same alertId as a recovery test. If it succeeds, the phone dedupes the
    // duplicate payload while still applying its transport-control metadata.
    const recoveryResult = await attempt(primary, body, config).catch((error) => ({ error }));
    if (!recoveryResult.error) {
      await recordTransportSuccess(primary, primary);
      attempts.push({ transport: primary, ok: true, recoveryTest: true, ...recoveryResult });
      return {
        alertId: body.alertId,
        transport: secondary,
        fallback: true,
        primaryRecovered: true,
        deliveryState: "primary_working",
        attempts,
      };
    }

    const classification = classifyFailure(primary, recoveryResult.error);
    await recordPrimaryFailure(primary, recoveryResult.error, classification, config);
    attempts.push({
      ...failedAttempt(primary, recoveryResult.error, classification),
      recoveryTest: true,
    });
    if (primary === "fcm" && classification.registrationInvalid) {
      await prepareWebSocketFallback(config, classification, recoveryResult.error, "fcm_registration_invalid");
    }
    return {
      alertId: body.alertId,
      transport: secondary,
      fallback: true,
      deliveryState: "fallback",
      attempts,
    };
  }

  // The fallback path failed. Give the configured primary an immediate chance;
  // if it works, it both delivers this alert and recovers the delivery state.
  const secondaryError = secondaryResult.error;
  await recordSecondaryFailure(secondary, primary, secondaryError, config);
  attempts.push(failedAttempt(secondary, secondaryError, classifyFailure(secondary, secondaryError)));

  const primaryResult = await attempt(primary, body, config).catch((error) => ({ error }));
  if (!primaryResult.error) {
    await recordTransportSuccess(primary, primary);
    attempts.push({ transport: primary, ok: true, recoveryTest: true, ...primaryResult });
    return {
      alertId: body.alertId,
      transport: primary,
      primaryRecovered: true,
      deliveryState: "primary_working",
      attempts,
    };
  }

  const classification = classifyFailure(primary, primaryResult.error);
  await recordPrimaryFailure(primary, primaryResult.error, classification, config);
  attempts.push({ ...failedAttempt(primary, primaryResult.error, classification), recoveryTest: true });
  if (primary === "fcm" && classification.registrationInvalid) {
    await prepareWebSocketFallback(config, classification, primaryResult.error, "fcm_registration_invalid");
  }
  throw deliveryError(body.alertId, attempts);
}

async function recordPrimaryFailure(primary, error, classification, config) {
  if (primary === "fcm" && classification.registrationInvalid) {
    return await markFcmRegistrationSuspect(primary, classification.code || "fcm_registration_invalid");
  }
  if (primary === "fcm" && classification.backoffActive) {
    return await readAlertRuntime(primary);
  }

  const { failureLimit } = failoverSettings(config, primary);
  let runtime = await recordTransportFailure(primary, primary, {
    error: errorSummary(error),
    nonRetryable: classification.nonRetryable,
    failureLimit,
  });
  if (primary === "fcm" && classification.retryAfterMs > 0) {
    runtime = await recordFcmBackoff(primary, {
      error: errorSummary(error),
      delayMs: classification.retryAfterMs,
    });
  }
  return runtime;
}

async function recordSecondaryFailure(secondary, primary, error, config) {
  const classification = classifyFailure(secondary, error);
  if (secondary === "fcm" && classification.backoffActive) return;

  const { failureLimit } = failoverSettings(config, secondary);
  await recordTransportFailure(secondary, primary, {
    error: errorSummary(error),
    nonRetryable: classification.nonRetryable,
    failureLimit,
  });
  if (secondary === "fcm" && classification.retryAfterMs > 0) {
    await recordFcmBackoff(primary, {
      error: errorSummary(error),
      delayMs: classification.retryAfterMs,
    });
  }
}

async function prepareWebSocketFallback(config, classification, error, reason = null) {
  const primary = config?.alerts?.transport || "websocket";
  const recoveryReason = reason || (classification.registrationInvalid ? "fcm_registration_invalid" : "fcm_alert_failed");
  await requestWebSocket(primary, recoveryReason);
  publishWorkerEvent(config, {
    type: recoveryReason,
    actions: classification.registrationInvalid
      ? ["ensure_fcm_registration", "start_ws"]
      : ["start_ws"],
    ...(error ? { error: errorSummary(error) } : {}),
  }).catch(() => {});
}

async function attemptFallbackTransport(transport, body, config) {
  let result = await attempt(transport, body, config).catch((error) => ({ error }));
  if (transport !== "websocket" || result.error?.code !== "NO_WS_CLIENTS") return result;

  const { wsActivationDelayMs } = failoverSettings(config, config?.alerts?.transport || "fcm");
  if (!workerEnabled(config) || wsActivationDelayMs <= 0) return result;

  // A Worker control push may have just asked Android to start cold-standby WS.
  await sleep(wsActivationDelayMs);
  result = await attempt(transport, body, config).catch((error) => ({ error }));
  return result;
}

function failedAttempt(transport, error, classification = {}) {
  return {
    transport,
    ok: false,
    error: errorSummary(error),
    code: classification.code || null,
  };
}

function deliveryError(alertId, attempts) {
  const summary = attempts
    .filter((a) => !a.ok)
    .map((a) => `${a.transport} (${a.error})`)
    .join(" and ");
  const error = new Error(`alert delivery failed on ${summary}`);
  error.attempts = attempts;
  error.alertId = alertId;
  return error;
}

async function attempt(transport, body, config) {
  const a = config?.alerts || {};
  const runtime = await readAlertRuntime(a.transport || "websocket");
  if (transport === "websocket") return await sendViaGuiHub(body, a, config);
  if (transport === "fcm") {
    const backoffMs = fcmBackoffRemainingMs(runtime);
    if (backoffMs > 0) {
      throw Object.assign(
        new Error(`FCM retry backoff active for ${Math.ceil(backoffMs / 1000)}s`),
        { code: "FCM_BACKOFF", backoffActive: true, retryAfterMs: backoffMs }
      );
    }

    // A successful FCM message can carry the phone's desired WS policy. For FCM
    // primary this is false; for WS primary it is true. The phone applies this
    // metadata even when alertId dedupe suppresses the duplicate alarm.
    return await sendViaFcm({
      ...body,
      websocketWanted: String((a.transport || "websocket") === "websocket"),
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

  const r = await fcmRequest(resolved.projectId, accessToken, {
    message: { ...target, data, android: { priority: "HIGH" } },
  });
  return { messageId: r.name || null, registrationKind: registration.kind };
}

async function sendFcmControl(config, data) {
  const resolved = await resolveFcmConfig(config?.alerts?.fcm || {});
  if (!resolved.serviceAccountValid || !resolved.projectId) {
    throw Object.assign(new Error("FCM recovery control is not configured"), { code: "FCM_CONFIG" });
  }
  const registration = await readFcmRegistration();
  if (!registration) {
    throw Object.assign(new Error("FCM phone registration missing"), { code: "FCM_REGISTRATION_MISSING", registrationInvalid: true });
  }
  const accessToken = await fcmAccessToken(resolved.serviceAccount);
  const target = registration.kind === "fid" ? { fid: registration.value } : { token: registration.value };
  const payload = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
  return await fcmRequest(resolved.projectId, accessToken, {
    message: { ...target, data: payload, android: { priority: "HIGH" } },
  });
}

function retryAfterMs(header, httpStatus) {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (httpStatus === 429) return 60_000;
  if (httpStatus === 503) return 5_000;
  if (httpStatus >= 500) return 2_000;
  return 0;
}

async function fcmRequest(projectId, accessToken, body) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const status = String(j.error?.status || "");
    const fcmDetail = Array.isArray(j.error?.details)
      ? j.error.details.find((d) => d?.["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError")
      : null;
    const fcmErrorCode = String(fcmDetail?.errorCode || "");
    const code = fcmErrorCode || status || `FCM_HTTP_${r.status}`;
    const e = new Error(`FCM send failed: ${r.status} ${code} ${j.error?.message || JSON.stringify(j)}`.trim());
    e.httpStatus = r.status;
    e.fcmStatus = status;
    e.fcmErrorCode = fcmErrorCode;
    e.code = code;
    e.retryAfterMs = retryAfterMs(r.headers.get("retry-after"), r.status);
    e.registrationInvalid =
      fcmErrorCode === "UNREGISTERED" ||
      status === "UNREGISTERED" ||
      (status === "INVALID_ARGUMENT" && fcmErrorCode === "INVALID_ARGUMENT");
    throw e;
  }
  return j;
}

/**
 * Periodic recovery check for an FCM primary that is retrying/fallen back.
 * Successful Firebase acceptance is the current recovery criterion; the control
 * message also tells Android to stop temporary WS. This runs only while FCM is
 * the configured primary and not PRIMARY_WORKING.
 */
export async function recoverAlertTransport(config) {
  const primary = config?.alerts?.transport || "websocket";
  if (primary !== "fcm") return { attempted: false, reason: "primary_not_fcm" };

  const runtime = await readAlertRuntime(primary);
  if (runtime.delivery.state === "primary_working") {
    return { attempted: false, reason: "already_working" };
  }
  const backoffMs = fcmBackoffRemainingMs(runtime);
  if (backoffMs > 0) {
    return { attempted: false, reason: "fcm_backoff", retryInMs: backoffMs };
  }

  try {
    const result = await sendFcmControl(config, {
      kind: "control",
      actions: "stop_ws",
      reason: "fcm_recovery_check",
      primaryTransport: "fcm",
      websocketWanted: "false",
    });
    await recordTransportSuccess("fcm", primary);
    return { attempted: true, recovered: true, messageId: result.name || null };
  } catch (error) {
    const classification = classifyFailure("fcm", error);
    if (classification.registrationInvalid) {
      await markFcmRegistrationSuspect(primary, classification.code || "fcm_registration_invalid");
      publishWorkerEvent(config, {
        type: "fcm_registration_invalid",
        actions: ["ensure_fcm_registration", "start_ws"],
        error: errorSummary(error),
      }).catch(() => {});
    } else if (classification.retryAfterMs > 0) {
      await recordFcmBackoff(primary, {
        error: errorSummary(error),
        delayMs: classification.retryAfterMs,
      });
    }
    return { attempted: true, recovered: false, error: errorSummary(error) };
  }
}

function classifyFailure(transport, error) {
  if (transport === "websocket") {
    return {
      code: error?.code || "WEBSOCKET_ERROR",
      nonRetryable: false,
      registrationInvalid: false,
      retryAfterMs: 0,
      backoffActive: false,
    };
  }

  const code = String(error?.fcmErrorCode || error?.fcmStatus || error?.code || "");
  const http = Number(error?.httpStatus || 0);
  const registrationInvalid = !!error?.registrationInvalid || code === "UNREGISTERED";
  const retryMs = Math.max(0, Number(error?.retryAfterMs) || 0);
  const backoffActive = !!error?.backoffActive || code === "FCM_BACKOFF";
  const nonRetryable =
    registrationInvalid ||
    code === "FCM_CONFIG" ||
    code === "FCM_AUTH" ||
    code === "SENDER_ID_MISMATCH";
  return {
    code: code || null,
    http,
    nonRetryable,
    registrationInvalid,
    retryAfterMs: retryMs,
    backoffActive,
  };
}
