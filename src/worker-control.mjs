// Optional Cloudflare Worker control-plane client. Direct PC/phone paths stay
// primary; this module mirrors state and provides a rendezvous/watchdog path.

import { controlState, newerWorkerRegistration } from "./alert-runtime.mjs";

let lastHeartbeatAt = 0;
let heartbeatInFlight = null;

function settings(config) {
  const w = config?.controlWorker || {};
  return {
    enabled: !!w.enabled && !!String(w.url || "").trim(),
    url: String(w.url || "").trim().replace(/\/+$/, ""),
    authTokenEnv: w.authTokenEnv || config?.gui?.authTokenEnv || "GUI_TOKEN",
    heartbeatIntervalMs: Math.max(Number(w.heartbeatIntervalMs) || 60_000, 10_000),
    heartbeatTimeoutMs: Math.max(Number(w.heartbeatTimeoutMs) || 180_000, 30_000),
  };
}

async function callWorker(config, path, body) {
  const w = settings(config);
  if (!w.enabled) return null;
  const token = process.env[w.authTokenEnv] || "";
  const r = await fetch(w.url + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`control worker rejected ${path}: ${r.status} ${j.error || ""}`.trim());
  if (j.phone) await newerWorkerRegistration(j.phone).catch(() => {});
  return j;
}

export async function syncWorkerHeartbeat(config, { force = false } = {}) {
  const w = settings(config);
  if (!w.enabled) return null;
  const now = Date.now();
  if (!force && now - lastHeartbeatAt < w.heartbeatIntervalMs) return null;
  if (heartbeatInFlight) return heartbeatInFlight;

  lastHeartbeatAt = now;
  heartbeatInFlight = (async () => {
    try {
      const state = await controlState(config);
      return await callWorker(config, "/api/pc/sync", {
        at: new Date().toISOString(),
        heartbeatTimeoutMs: w.heartbeatTimeoutMs,
        state,
      });
    } finally {
      heartbeatInFlight = null;
    }
  })();
  return heartbeatInFlight;
}

export async function publishWorkerEvent(config, event) {
  const w = settings(config);
  if (!w.enabled) return null;
  const state = await controlState(config);
  return await callWorker(config, "/api/pc/event", {
    at: new Date().toISOString(),
    event,
    state,
  });
}

export function workerEnabled(config) {
  return settings(config).enabled;
}
