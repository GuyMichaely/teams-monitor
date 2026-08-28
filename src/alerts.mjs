// Phone alerting — the transport behind the `alert_phone` action.
//
// Two transports, selected by config.alerts.transport:
//
//   "websocket" — POST the alert to the GUI server (default
//                 http://127.0.0.1:8090/api/alerts), which broadcasts it to
//                 companion apps connected on /ws/alerts. Works today with any
//                 WebSocket client; the Android app will just be one of those.
//
//   "fcm"       — Firebase Cloud Messaging (HTTP v1), sent straight from here.
//                 Data-only message with Android HIGH priority so the app's
//                 own receiver decides how to alarm (a "notification" payload
//                 would let the system render it instead). Needs a service
//                 account JSON and the app's registration token in config.
//
// Zero-dependency: the FCM OAuth flow is a hand-signed RS256 JWT (node:crypto)
// exchanged for an access token, cached until just before expiry.

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./state.mjs";
import { resolveFcmConfig } from "./fcm-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_DEVICE_TOKEN_FILE = join(DATA_DIR, "fcm-device-token.txt");

const truncate = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * Send one alert. payload: { chat, author, text, time }.
 * Returns a transport-specific result object; throws on misconfig/failure.
 */
export async function sendAlert(payload, config) {
  const a = config?.alerts || {};
  const body = {
    chat: String(payload.chat ?? ""),
    author: String(payload.author ?? ""),
    text: truncate(payload.text),
    time: payload.time || null,
  };
  const transport = a.transport || "websocket";
  if (transport === "websocket") return await sendViaGuiHub(body, a, config);
  if (transport === "fcm") return await sendViaFcm(body, a);
  throw new Error(`unknown alerts.transport: "${transport}" (expected "websocket" or "fcm")`);
}

// ---- websocket (via the GUI server's hub) -----------------------------------

async function sendViaGuiHub(body, a, config) {
  const g = config?.gui || {};
  // The hub always lives on this machine; a wildcard bind address (0.0.0.0,
  // for LAN access) is not a connectable address, so fall back to loopback.
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
  if (!r.ok) throw new Error(`alert hub rejected: ${r.status} ${j.error || ""}`.trim());
  return { transport: "websocket", delivered: j.delivered ?? 0 };
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
  });
  if (!r.ok) throw new Error(`FCM OAuth token exchange failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  cachedToken = { accessToken: j.access_token, expMs: Date.now() + j.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function sendViaFcm(body, fcm) {
  const resolved = await resolveFcmConfig(fcm);
  if (!resolved.serviceAccountValid) {
    const detail = resolved.serviceAccountPresent ? "invalid service account JSON" : "service account file missing";
    throw new Error(`alerts.fcm not configured — ${detail}: ${resolved.serviceAccountFile}`);
  }
  if (!resolved.projectId) {
    throw new Error("alerts.fcm not configured — project ID missing from both config override and service account");
  }
  let deviceToken = "";
  try { deviceToken = (await readFile(FCM_DEVICE_TOKEN_FILE, "utf8")).trim(); } catch { /* not registered yet */ }
  if (!deviceToken) {
    throw new Error("FCM device token not registered — open the Android app while the GUI/tunnel is reachable");
  }
  const sa = resolved.serviceAccount;
  const accessToken = await fcmAccessToken(sa);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(resolved.projectId)}/messages:send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        data: { chat: body.chat, author: body.author, text: body.text, time: body.time || "" },
        android: { priority: "HIGH" },
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`FCM send failed: ${r.status} ${j.error?.message || JSON.stringify(j)}`);
  return { transport: "fcm", messageId: j.name || null };
}
