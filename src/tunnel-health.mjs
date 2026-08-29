// Public-tunnel health monitoring used when the optional control Worker is off.
// Observation state is separate from report state so a failed FCM health push is
// retried on later checks instead of being lost after the first transition.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./state.mjs";
import { publicHealthUrl } from "./tunnel-config.mjs";

export const TUNNEL_HEALTH_FILE = join(DATA_DIR, "tunnel-health.json");
let lastCheckAt = 0;

async function readState() {
  try { return JSON.parse(await readFile(TUNNEL_HEALTH_FILE, "utf8")); }
  catch { return null; }
}

async function writeState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${TUNNEL_HEALTH_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, TUNNEL_HEALTH_FILE);
}

function observationStatus(reachable) {
  return reachable === false ? "missing" : "recovered";
}

export async function checkPublicTunnel(config, { force = false } = {}) {
  const w = config?.controlWorker || {};
  const intervalMs = Math.max(Number(w.heartbeatIntervalMs) || 60_000, 10_000);
  const url = publicHealthUrl(config);
  const now = Date.now();
  if (!force && now - lastCheckAt < intervalMs) return null;
  lastCheckAt = now;

  const previous = await readState();
  const checkedAt = new Date().toISOString();

  if (!url) {
    // Disabling the probe resolves a previously reported missing incident. Keep
    // state until that recovery notification succeeds so a failed FCM send can
    // be retried on the next health tick.
    const reportedStatus = previous?.reportedStatus || null;
    const status = reportedStatus === "missing" ? "recovered" : null;
    const current = {
      configured: false,
      reachable: null,
      statusCode: null,
      error: null,
      checkedAt,
      reportedStatus: reportedStatus || "recovered",
      reportedAt: previous?.reportedAt || null,
    };
    await writeState(current);
    return {
      ...current,
      changed: previous?.reachable === false,
      status,
      needsReport: status === "recovered",
    };
  }

  let reachable = false;
  let statusCode = null;
  let error = null;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    statusCode = response.status;
    reachable = response.ok;
    await response.body?.cancel().catch(() => {});
  } catch (e) {
    error = String(e?.message || e).slice(0, 300);
  }

  const status = observationStatus(reachable);
  // A first healthy observation establishes the baseline without notifying the
  // phone. Otherwise preserve the last successfully reported status.
  const reportedStatus = previous?.reportedStatus || (reachable ? "recovered" : null);
  const current = {
    configured: true,
    reachable,
    statusCode,
    error,
    checkedAt,
    reportedStatus,
    reportedAt: previous?.reportedAt || null,
  };
  await writeState(current);

  return {
    ...current,
    changed: previous?.reachable !== reachable,
    status: previous?.reachable === undefined && reachable ? null : status,
    needsReport: status !== reportedStatus,
  };
}

export async function markPublicTunnelReported(status, at = new Date().toISOString()) {
  const normalized = status === "missing" || status === "recovered" ? status : null;
  if (!normalized) return false;
  const state = await readState();
  if (!state) return false;

  // Do not acknowledge a report for an observation that has already changed.
  const currentStatus = state.configured === false
    ? "recovered"
    : observationStatus(state.reachable);
  if (currentStatus !== normalized) return false;

  await writeState({
    ...state,
    reportedStatus: normalized,
    reportedAt: at,
  });
  return true;
}
