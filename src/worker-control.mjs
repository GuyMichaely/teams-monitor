// Optional Cloudflare Worker control-plane client. Direct PC/phone paths stay
// primary; this module mirrors state and provides a rendezvous/watchdog path.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { controlState, newerWorkerRegistration } from "./alert-runtime.mjs";
import { DATA_DIR } from "./state.mjs";

const ORCHESTRATOR_HEARTBEAT_FILE = join(DATA_DIR, "heartbeat.json");
let lastHeartbeatAt = 0;
let heartbeatInFlight = null;

function settings(config) {
  const w = config?.controlWorker || {};
  return {
    enabled: !!w.enabled && !!String(w.url || "").trim(),
    url: String(w.url || "").trim().replace(/\/+$/, ""),
    publicHealthUrl: String(w.publicHealthUrl || "").trim(),
    authTokenEnv: w.authTokenEnv || config?.gui?.authTokenEnv || "GUI_TOKEN",
    heartbeatIntervalMs: Math.max(Number(w.heartbeatIntervalMs) || 60_000, 10_000),
    heartbeatTimeoutMs: Math.max(Number(w.heartbeatTimeoutMs) || 180_000, 30_000),
  };
}

async function localOrchestratorHeartbeat(config) {
  try {
    const hb = JSON.parse(await readFile(ORCHESTRATOR_HEARTBEAT_FILE, "utf8"));
    const ageMs = Date.now() - Date.parse(hb?.at || 0);
    const maxAgeMs = Math.max(2 * (Number(config?.pollIntervalMs) || 15_000), 45_000);
    return ageMs >= 0 && ageMs <= maxAgeMs ? { ...hb, ageMs } : null;
  } catch {
    return null;
  }
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

  // The Worker heartbeat represents a fresh orchestrator tick, not merely a
  // living CLI process. If Teams polling is wedged, stop feeding the watchdog.
  const localHeartbeat = await localOrchestratorHeartbeat(config);
  if (!localHeartbeat) return null;

  lastHeartbeatAt = now;
  heartbeatInFlight = (async () => {
    try {
      const state = await controlState(config);
      return await callWorker(config, "/api/pc/sync", {
        at: new Date().toISOString(),
        orchestratorHeartbeatAt: localHeartbeat.at,
        heartbeatTimeoutMs: w.heartbeatTimeoutMs,
        publicHealthUrl: w.publicHealthUrl || null,
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
