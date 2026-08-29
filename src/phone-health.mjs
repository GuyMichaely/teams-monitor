// Narrow FCM control sender for PC-observed health incidents. Kept independent
// from alert delivery state: failure to send a watchdog update must not mutate
// the alert transport state machine.

import { createSign } from "node:crypto";
import { readFcmRegistration } from "./alert-runtime.mjs";
import { resolveFcmConfig } from "./fcm-config.mjs";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
let cachedToken = null;

async function accessToken(serviceAccount) {
  if (cachedToken && Date.now() < cachedToken.expMs - 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({
      iss: serviceAccount.client_email,
      scope: FCM_SCOPE,
      aud: serviceAccount.token_uri,
      iat: now,
      exp: now + 3600,
    });
  const jwt = unsigned + "." +
    createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key, "base64url");

  const response = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`health FCM OAuth failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  cachedToken = {
    value: body.access_token,
    expMs: Date.now() + Number(body.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

export async function sendPhoneHealth(config, { incident, status, at = null } = {}) {
  const resolved = await resolveFcmConfig(config?.alerts?.fcm || {});
  if (!resolved.serviceAccountValid || !resolved.projectId) {
    throw new Error("FCM health sender is not configured");
  }
  const registration = await readFcmRegistration();
  if (!registration) throw new Error("FCM phone registration missing");

  const token = await accessToken(resolved.serviceAccount);
  const target = registration.kind === "fid"
    ? { fid: registration.value }
    : { token: registration.value };
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(resolved.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: {
          ...target,
          data: {
            kind: "health",
            incident: String(incident || ""),
            status: String(status || ""),
            at: String(at || new Date().toISOString()),
          },
          android: { priority: "HIGH" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`health FCM send failed: ${response.status} ${body.error?.status || ""} ${body.error?.message || ""}`.trim());
  }
  return { messageId: body.name || null, registrationGeneration: registration.generation };
}
