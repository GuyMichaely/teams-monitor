// Public-tunnel health monitoring used when the optional control Worker is off.
// The Worker performs the same check independently when it is enabled.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./state.mjs";

const STATE_FILE = join(DATA_DIR, "tunnel-health.json");
let lastCheckAt = 0;

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); }
  catch { return null; }
}

async function writeState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, STATE_FILE);
}

export async function checkPublicTunnel(config, { force = false } = {}) {
  const w = config?.controlWorker || {};
  const intervalMs = Math.max(Number(w.heartbeatIntervalMs) || 60_000, 10_000);
  const url = String(w.publicHealthUrl || "").trim();
  const now = Date.now();
  if (!force && now - lastCheckAt < intervalMs) return null;
  lastCheckAt = now;

  const previous = await readState();
  if (!url) {
    await rm(STATE_FILE, { force: true }).catch(() => {});
    return {
      configured: false,
      changed: previous?.reachable === false,
      status: previous?.reachable === false ? "recovered" : null,
      checkedAt: new Date().toISOString(),
    };
  }

  const checkedAt = new Date().toISOString();
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

  const current = {
    configured: true,
    reachable,
    statusCode,
    error,
    checkedAt,
  };
  await writeState(current);

  return {
    ...current,
    changed: previous?.reachable !== reachable,
    // Initial healthy state is informational only. Initial failure is an incident.
    status: previous?.reachable === undefined && reachable
      ? null
      : reachable ? "recovered" : "missing",
  };
}
