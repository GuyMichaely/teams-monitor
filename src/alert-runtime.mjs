// Shared alert-delivery state persisted under data/ so the orchestrator and GUI
// can coordinate without making either process the source of truth for the other.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  let acquired = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      // A directory creation is a single atomic operation on Windows and avoids
      // the close→unlink race that file-handle locks have there.
      await mkdir(lockPath);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (attempt % 20 === 19) {
        try {
          const s = await stat(lockPath);
          if (Date.now() - s.mtimeMs > 10_000) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch { /* another process released it */ }
      }
      await sleep(25);
    }
  }
  if (!acquired) throw new Error(`timed out acquiring ${label} lock`);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function withRuntimeLock(fn) {
  return await withFileLock(ALERT_RUNTIME_LOCK, "alert runtime", fn);
}

function normalizeRegistration(current) {
  if (!current?.value || !["fid", "token"].includes(current.kind)) return null;
  return {
    ...current,
    generation: Number.isInteger(current.generation) && current.generation >= 0
      ? current.generation
      : 1,
  };
}

async function readFcmRegistrationUnlocked() {
  const current = normalizeRegistration(await readJson(FCM_REGISTRATION_FILE));
  if (current) return current;

  // One-release migration path from the deprecated registration-token file.
  try {
    const token = (await readFile(LEGACY_FCM_TOKEN_FILE, "utf8")).trim();
    if (token) {
      return {
        kind: "token",
        value: token,
        generation: 0,
        observedAt: null,
        updatedAt: null,
        legacy: true,
      };
    }
  } catch { /* no legacy registration */ }
  return null;
}

export async function readFcmRegistration() {
  return await readFcmRegistrationUnlocked();
}

function generationMatches(current, expectedGeneration) {
  if (expectedGeneration === -1) return !current;
  return !!current && current.generation === expectedGeneration;
}

async function mutateForFcmGeneration(primaryTransport, expectedGeneration, mutate) {
  if (!Number.isInteger(expectedGeneration)) {
    return await updateAlertRuntime(primaryTransport, mutate);
  }

  return await withFileLock(FCM_REGISTRATION_LOCK, "FCM registration", async () => {
    const current = await readFcmRegistrationUnlocked();
    if (!generationMatches(current, expectedGeneration)) {
      const runtime = await readAlertRuntime(primaryTransport);
      return { ...runtime, ignoredStaleFcmResult: true };
    }
    return await updateAlertRuntime(primaryTransport, mutate);
  });
}

export async function isCurrentFcmRegistrationGeneration(expectedGeneration) {
  if (!Number.isInteger(expectedGeneration)) return true;
  const current = await readFcmRegistration();
  return generationMatches(current, expectedGeneration);
}

export async function saveFcmRegistration({ fid, token, source = "phone", observedAt = null } = {}) {
  const kind = typeof fid === "string" && fid.trim() ? "fid" : "token";
  const value = String(kind === "fid" ? fid : token || "").trim();
  if (value.length < 8 || value.length > 4096) {
    throw Object.assign(new Error("invalid FCM registration identifier"), { httpCode: 400 });
  }

  const incomingObservedAt = observedAt || iso();
  let registration;
  let registrationChanged = false;

  await withFileLock(FCM_REGISTRATION_LOCK, "FCM registration", async () => {
    const current = await readFcmRegistrationUnlocked();
    const sameRegistration = current?.kind === kind && current.value === value;

    if (current?.value && !sameRegistration) {
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

    registrationChanged = !current || current.legacy || !sameRegistration;
    const currentGeneration = Number.isInteger(current?.generation) ? current.generation : 0;
    const generation = registrationChanged ? currentGeneration + 1 : currentGeneration;

    const currentObservedAt = Date.parse(current?.observedAt || current?.updatedAt || 0);
    const incomingAt = Date.parse(incomingObservedAt);
    const effectiveObservedAt =
      !registrationChanged && Number.isFinite(currentObservedAt) &&
      (!Number.isFinite(incomingAt) || incomingAt < currentObservedAt)
        ? current.observedAt || current.updatedAt
        : incomingObservedAt;

    registration = {
      kind,
      value,
      generation,
      source,
      observedAt: effectiveObservedAt,
      updatedAt: iso(),
    };
    await atomicWriteJson(FCM_REGISTRATION_FILE, registration);

    // Keep the old presence check/UI working during the FID migration. New sends
    // read FCM_REGISTRATION_FILE and know whether this value is a fid or token.
    await writeFile(LEGACY_FCM_TOKEN_FILE, value + "\n", { mode: 0o600 });
  });

  // A duplicate upload of the same registration must not clear a failure that
  // was observed after that upload was queued. Only a genuinely new generation
  // resets registration/backoff state.
  if (registrationChanged && !registration?.ignoredStale) {
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

  // Drop obsolete receipt-probe fields from older runtime files.
  delete runtime.fcm.pendingProbe;
  delete runtime.fcm.lastAckProbeId;
  delete runtime.fcm.lastAckAt;

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

function applyTransportSuccess(runtime, transport, primaryTransport) {
  runtime.delivery.failures[transport] = 0;

  if (transport === "fcm") {
    runtime.fcm.lastSuccessAt = iso();
    runtime.fcm.lastError = null;
    runtime.fcm.nextAttemptAt = null;
    runtime.fcm.backoffMs = 0;
    if (runtime.fcm.registration === "suspect") runtime.fcm.registration = "synced";
  }

  if (transport === primaryTransport) {
    runtime.delivery.state = "primary_working";
    runtime.delivery.activeTransport = primaryTransport;
    runtime.recoveryReason = null;
    if (primaryTransport === "fcm") runtime.websocketWanted = false;
  } else if (runtime.delivery.state === "fallback") {
    runtime.delivery.activeTransport = transport;
  }
  return runtime;
}

export async function recordTransportSuccess(
  transport,
  primaryTransport,
  { registrationGeneration = null } = {}
) {
  const mutate = (runtime) => applyTransportSuccess(runtime, transport, primaryTransport);
  if (transport === "fcm") {
    return await mutateForFcmGeneration(primaryTransport, registrationGeneration, mutate);
  }
  return await updateAlertRuntime(primaryTransport, mutate);
}

export async function recordTransportFailure(
  transport,
  primaryTransport,
  {
    error = null,
    nonRetryable = false,
    failureLimit = 3,
    registrationGeneration = null,
  } = {}
) {
  const mutate = (runtime) => {
    runtime.delivery.failures[transport] = (runtime.delivery.failures[transport] || 0) + 1;
    if (transport === "fcm") runtime.fcm.lastError = error || null;

    if (transport === primaryTransport) {
      const fallback = nonRetryable || runtime.delivery.failures[transport] >= failureLimit;
      runtime.delivery.state = fallback ? "fallback" : "primary_retrying";
      runtime.delivery.activeTransport = fallback
        ? (transport === "fcm" ? "websocket" : "fcm")
        : primaryTransport;
      runtime.recoveryReason = fallback ? (error || `${transport}_failure_limit`) : null;
      if (fallback && primaryTransport === "fcm") runtime.websocketWanted = true;
    }
    return runtime;
  };

  if (transport === "fcm") {
    return await mutateForFcmGeneration(primaryTransport, registrationGeneration, mutate);
  }
  return await updateAlertRuntime(primaryTransport, mutate);
}

export async function recordFcmBackoff(
  primaryTransport,
  { error = null, delayMs = 0, registrationGeneration = null } = {}
) {
  const delay = Math.max(0, Number(delayMs) || 0);
  return await mutateForFcmGeneration(primaryTransport, registrationGeneration, (runtime) => {
    runtime.fcm.lastError = error || runtime.fcm.lastError || null;
    runtime.fcm.backoffMs = delay;
    runtime.fcm.nextAttemptAt = delay > 0 ? new Date(Date.now() + delay).toISOString() : null;
    return runtime;
  });
}

export async function markFcmRegistrationSuspect(
  primaryTransport,
  reason = "unregistered",
  { registrationGeneration = null } = {}
) {
  return await mutateForFcmGeneration(primaryTransport, registrationGeneration, (runtime) => {
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
      registrationGeneration: registration?.generation ?? null,
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
  const saved = await saveFcmRegistration({
    fid,
    source: "worker",
    observedAt: phone.registrationUpdatedAt || phone.updatedAt || null,
  });
  return !saved?.ignoredStale;
}

export function registrationFileExists() {
  return existsSync(FCM_REGISTRATION_FILE) || existsSync(LEGACY_FCM_TOKEN_FILE);
}
