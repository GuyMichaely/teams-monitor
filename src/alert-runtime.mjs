// Shared alert-delivery state persisted under data/ so the orchestrator and GUI
// can coordinate without making either process the source of truth for the other.

import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./state.mjs";

export const FCM_REGISTRATION_FILE = join(DATA_DIR, "fcm-registration.json");
export const LEGACY_FCM_TOKEN_FILE = join(DATA_DIR, "fcm-device-token.txt");
export const ALERT_RUNTIME_FILE = join(DATA_DIR, "alert-runtime.json");
const ALERT_RUNTIME_LOCK = join(DATA_DIR, "alert-runtime.lock");
const FCM_REGISTRATION_LOCK = join(DATA_DIR, "fcm-registration.lock");

const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freshRuntime(primaryTransport = "fcm") {
  return {
    updatedAt: iso(),
    delivery: {
      primaryTransport,
      state: "primary_working",
      activeTransport: primaryTransport,
      failures: { fcm: 0, websocket: 0 },
    },
    fcm: {
      registration: "unknown",
      lastError: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      backoffMs: 0,
    },
    websocketWanted: primaryTransport === "websocket",
    recoveryReason: null,
  };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

async function atomicWriteJson(path, value) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

async function withFileLock(lockPath, label, fn) {
  await mkdir(DATA_DIR, { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A hard-killed process can leave the lock file behind.
      if (attempt % 20 === 19) {
        try {
          const s = await stat(lockPath);
          if (Date.now() - s.mtimeMs > 10_000) await unlink(lockPath);
        } catch { /* another process released it */ }
      }
      await sleep(25);
    }
  }
  if (!handle) throw new Error(`timed out acquiring ${label} lock`);
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function withRuntimeLock(fn) {
  return await withFileLock(ALERT_RUNTIME_LOCK, "alert runtime", fn);
}

export async function readFcmRegistration() {
  const current = await readJson(FCM_REGISTRATION_FILE);
  if (current?.value && ["fid", "token"].includes(current.kind)) return current;

  // One-release migration path from the deprecated registration-token file.
  try {
    const token = (await readFile(LEGACY_FCM_TOKEN_FILE, "utf8")).trim();
    if (token) return { kind: "token", value: token, observedAt: null, updatedAt: null, legacy: true };
  } catch { /* no legacy registration */ }
  return null;
}

export async function saveFcmRegistration({ fid, token, source = "phone", observedAt = null } = {}) {
  const kind = typeof fid === "string" && fid.trim() ? "fid" : "token";
  const value = String(kind === "fid" ? fid : token || "").trim();
  if (value.length < 8 || value.length > 4096) {
    throw Object.assign(new Error("invalid FCM registration identifier"), { httpCode: 400 });
  }

  const incomingObservedAt = observedAt || iso();
  let registration;
  let accepted = false;

  await withFileLock(FCM_REGISTRATION_LOCK, "FCM registration", async () => {
    const current = await readJson(FCM_REGISTRATION_FILE);
    if (current?.value && current.value !== value) {
      const incomingAt = Date.parse(incomingObservedAt);
      const currentAt = Date.parse(current.observedAt || current.updatedAt || 0);
      // Network callbacks/WorkManager attempts can arrive out of order. Once we
      // have a timestamped registration, an older or undated different FID may
      // never replace it.
      if (Number.isFinite(currentAt) && (!Number.isFinite(incomingAt) || incomingAt < currentAt)) {
        registration = { ...current, ignoredStale: true };
        return;
      }
    }

    registration = {
      kind,
      value,
      source,
      observedAt: incomingObservedAt,
      updatedAt: iso(),
    };
    await atomicWriteJson(FCM_REGISTRATION_FILE, registration);

    // Keep the old presence check/UI working during the FID migration. New sends
    // read FCM_REGISTRATION_FILE and know whether this value is a fid or token.
    await writeFile(LEGACY_FCM_TOKEN_FILE, value + "\n", { mode: 0o600 });
    accepted = true;
  });

  if (accepted) {
    await updateAlertRuntime(null, (runtime) => {
      runtime.fcm.registration = "synced";
      runtime.fcm.lastError = null;
      runtime.fcm.nextAttemptAt = null;
      runtime.fcm.backoffMs = 0;
      return runtime;
    });
  }
  return registration;
}

function normalizeRuntime(stored, primaryTransport) {
  const runtime = stored || freshRuntime(primaryTransport);
  runtime.delivery ||= freshRuntime(primaryTransport).delivery;
  runtime.delivery.failures ||= { fcm: 0, websocket: 0 };
  runtime.fcm ||= freshRuntime(primaryTransport).fcm;
  runtime.fcm.nextAttemptAt ??= null;
  runtime.fcm.backoffMs = Math.max(0, Number(runtime.fcm.backoffMs) || 0);

  if (runtime.delivery.primaryTransport !== primaryTransport) {
    runtime.delivery.primaryTransport = primaryTransport;
    runtime.delivery.state = "primary_working";
    runtime.delivery.activeTransport = primaryTransport;
    runtime.delivery.failures = { fcm: 0, websocket: 0 };
    runtime.websocketWanted = primaryTransport === "websocket";
    runtime.recoveryReason = null;
  }
  return runtime;
}

export async function readAlertRuntime(primaryTransport = "fcm") {
  return normalizeRuntime(await readJson(ALERT_RUNTIME_FILE), primaryTransport);
}

export async function updateAlertRuntime(primaryTransport, mutate) {
  return await withRuntimeLock(async () => {
    const stored = await readJson(ALERT_RUNTIME_FILE);
    const primary = primaryTransport || stored?.delivery?.primaryTransport || "fcm";
    const runtime = normalizeRuntime(stored, primary);
    const next = (await mutate(runtime)) || runtime;
    next.updatedAt = iso();
    await atomicWriteJson(ALERT_RUNTIME_FILE, next);
    return next;
  });
}

export async function recordTransportSuccess(transport, primaryTransport) {
  return await updateAlertRuntime(primaryTransport, (runtime) => {
    runtime.delivery.failures[transport] = 0;
    if (transport === primaryTransport) {
      runtime.delivery.state = "primary_working";
      runtime.delivery.activeTransport = primaryTransport;
      runtime.recoveryReason = null;
      if (primaryTransport === "fcm") runtime.websocketWanted = false;
    } else if (runtime.delivery.state === "fallback") {
      runtime.delivery.activeTransport = transport;
    }
    if (transport === "fcm") {
      runtime.fcm.lastSuccessAt = iso();
      runtime.fcm.lastError = null;
      runtime.fcm.nextAttemptAt = null;
      runtime.fcm.backoffMs = 0;
      if (runtime.fcm.registration === "suspect") runtime.fcm.registration = "synced";
    }
    return runtime;
  });
}

export async function recordTransportFailure(transport, primaryTransport, { error = null, nonRetryable = false, failureLimit = 3 } = {}) {
  return await updateAlertRuntime(primaryTransport, (runtime) => {
    runtime.delivery.failures[transport] = (runtime.delivery.failures[transport] || 0) + 1;
    if (transport === "fcm") runtime.fcm.lastError = error || null;

    if (transport === primaryTransport) {
      const fallback = nonRetryable || runtime.delivery.failures[transport] >= failureLimit;
      runtime.delivery.state = fallback ? "fallback" : "primary_retrying";
      runtime.delivery.activeTransport = fallback ? (transport === "fcm" ? "websocket" : "fcm") : primaryTransport;
      runtime.recoveryReason = fallback ? (error || `${transport}_failure_limit`) : null;
      if (fallback && primaryTransport === "fcm") runtime.websocketWanted = true;
    }
    return runtime;
  });
}

export async function recordFcmBackoff(primaryTransport, { error = null, delayMs = 0 } = {}) {
  const delay = Math.max(0, Number(delayMs) || 0);
  return await updateAlertRuntime(primaryTransport, (runtime) => {
    runtime.fcm.lastError = error || runtime.fcm.lastError || null;
    runtime.fcm.backoffMs = delay;
    runtime.fcm.nextAttemptAt = delay > 0 ? new Date(Date.now() + delay).toISOString() : null;
    return runtime;
  });
}

export async function markFcmRegistrationSuspect(primaryTransport, reason = "unregistered") {
  return await updateAlertRuntime(primaryTransport, (runtime) => {
    runtime.fcm.registration = "suspect";
    runtime.fcm.lastError = reason;
    runtime.fcm.nextAttemptAt = null;
    runtime.fcm.backoffMs = 0;
    if (primaryTransport === "fcm") {
      runtime.delivery.state = "fallback";
      runtime.delivery.activeTransport = "websocket";
      runtime.websocketWanted = true;
      runtime.recoveryReason = reason;
    }
    return runtime;
  });
}

export async function requestWebSocket(primaryTransport, reason = "fallback") {
  return await updateAlertRuntime(primaryTransport, (runtime) => {
    runtime.websocketWanted = true;
    runtime.recoveryReason ||= reason;
    return runtime;
  });
}

export async function controlState(config) {
  const primaryTransport = config?.alerts?.transport || "websocket";
  const runtime = await readAlertRuntime(primaryTransport);
  const registration = await readFcmRegistration();
  return {
    primaryTransport,
    delivery: runtime.delivery,
    websocketWanted: primaryTransport === "websocket" || !!runtime.websocketWanted,
    fcm: {
      registrationStatus: runtime.fcm.registration,
      registrationPresent: !!registration,
      registrationKind: registration?.kind || null,
      registrationUpdatedAt: registration?.updatedAt || null,
      lastError: runtime.fcm.lastError,
      lastSuccessAt: runtime.fcm.lastSuccessAt,
      nextAttemptAt: runtime.fcm.nextAttemptAt,
      backoffMs: runtime.fcm.backoffMs,
    },
    controlWorker: {
      enabled: !!config?.controlWorker?.enabled,
      url: config?.controlWorker?.enabled ? String(config.controlWorker.url || "") : "",
    },
    updatedAt: runtime.updatedAt,
  };
}

export async function newerWorkerRegistration(phone) {
  const fid = typeof phone?.fid === "string" ? phone.fid.trim() : "";
  if (!fid) return false;
  const remoteAt = Date.parse(phone.registrationUpdatedAt || phone.updatedAt || 0);
  const local = await readFcmRegistration();
  const localAt = Date.parse(local?.observedAt || local?.updatedAt || 0);
  if (local?.kind === "fid" && local.value === fid) return false;
  if (local && !Number.isFinite(remoteAt)) return false;
  if (Number.isFinite(remoteAt) && Number.isFinite(localAt) && remoteAt < localAt) return false;
  const saved = await saveFcmRegistration({ fid, source: "worker", observedAt: phone.registrationUpdatedAt || phone.updatedAt || null });
  return !saved?.ignoredStale;
}

export function registrationFileExists() {
  return existsSync(FCM_REGISTRATION_FILE) || existsSync(LEGACY_FCM_TOKEN_FILE);
}
