import { rm } from "node:fs/promises";
import {
  ALERT_RUNTIME_FILE,
  FCM_REGISTRATION_FILE,
  LEGACY_FCM_TOKEN_FILE,
  markFcmRegistrationSuspect,
  readAlertRuntime,
  readFcmRegistration,
  recordFcmBackoff,
  recordTransportFailure,
  recordTransportSuccess,
  saveFcmRegistration,
} from "../src/alert-runtime.mjs";

const RUNTIME_LOCK_FILE = ALERT_RUNTIME_FILE.replace(/alert-runtime\.json$/, "alert-runtime.lock");
const REGISTRATION_LOCK_FILE = FCM_REGISTRATION_FILE.replace(/fcm-registration\.json$/, "fcm-registration.lock");

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function clean() {
  await Promise.all([
    rm(ALERT_RUNTIME_FILE, { force: true }),
    rm(RUNTIME_LOCK_FILE, { force: true }),
    rm(FCM_REGISTRATION_FILE, { force: true }),
    rm(REGISTRATION_LOCK_FILE, { force: true }),
    rm(LEGACY_FCM_TOKEN_FILE, { force: true }),
  ]);
}

await clean();
try {
  let state = await readAlertRuntime("fcm");
  assert(state.delivery.state === "primary_working", "fresh runtime is primary_working");
  assert(state.websocketWanted === false, "FCM primary does not want WS initially");

  state = await recordTransportFailure("fcm", "fcm", {
    error: "temporary",
    failureLimit: 2,
  });
  assert(state.delivery.state === "primary_retrying", "first retryable failure keeps primary");

  state = await recordTransportFailure("fcm", "fcm", {
    error: "temporary",
    failureLimit: 2,
  });
  assert(state.delivery.state === "fallback", "failure limit enters fallback");
  assert(state.delivery.activeTransport === "websocket", "fallback transport is WS");
  assert(state.websocketWanted === true, "FCM fallback requests WS");

  state = await recordTransportSuccess("websocket", "fcm");
  assert(state.delivery.state === "fallback", "secondary success does not recover primary");

  state = await recordTransportSuccess("fcm", "fcm");
  assert(state.delivery.state === "primary_working", "one primary success recovers");
  assert(state.websocketWanted === false, "FCM recovery releases temporary WS");

  state = await recordFcmBackoff("fcm", { error: "quota", delayMs: 60_000 });
  assert(state.fcm.backoffMs === 60_000, "FCM backoff duration is persisted");
  assert(Date.parse(state.fcm.nextAttemptAt) > Date.now(), "FCM next-attempt timestamp is in the future");

  state = await recordTransportSuccess("fcm", "fcm");
  assert(state.fcm.backoffMs === 0, "FCM success clears retry backoff");
  assert(state.fcm.nextAttemptAt === null, "FCM success clears next-attempt timestamp");

  state = await markFcmRegistrationSuspect("fcm", "UNREGISTERED");
  assert(state.delivery.state === "fallback", "invalid FCM registration skips retry threshold");
  assert(state.fcm.registration === "suspect", "registration marked suspect");

  await saveFcmRegistration({
    fid: "smoke-fid-123456789",
    source: "smoke",
    observedAt: "2026-08-29T00:00:00.000Z",
  });
  let registration = await readFcmRegistration();
  assert(registration?.kind === "fid", "FID registration persisted");
  assert(registration?.value === "smoke-fid-123456789", "FID registration value round-trips");

  await saveFcmRegistration({
    fid: "smoke-fid-newer-123456789",
    source: "smoke-newer",
    observedAt: "2026-08-29T00:02:00.000Z",
  });
  const staleResult = await saveFcmRegistration({
    fid: "smoke-fid-stale-123456789",
    source: "smoke-stale",
    observedAt: "2026-08-29T00:01:00.000Z",
  });
  registration = await readFcmRegistration();
  assert(staleResult?.ignoredStale === true, "older different FID is rejected as stale");
  assert(registration?.value === "smoke-fid-newer-123456789", "stale FID cannot replace newer registration");

  // Registration requests can complete in any network order. The registration
  // lock + observedAt comparison must make the newest observation win anyway.
  await Promise.all([
    saveFcmRegistration({ fid: "smoke-fid-t3-123456789", source: "concurrent", observedAt: "2026-08-29T00:05:00.000Z" }),
    saveFcmRegistration({ fid: "smoke-fid-t1-123456789", source: "concurrent", observedAt: "2026-08-29T00:03:00.000Z" }),
    saveFcmRegistration({ fid: "smoke-fid-t2-123456789", source: "concurrent", observedAt: "2026-08-29T00:04:00.000Z" }),
  ]);
  registration = await readFcmRegistration();
  assert(registration?.value === "smoke-fid-t3-123456789", "newest concurrent FID observation wins");

  // Exercise the cross-process runtime lock with concurrent mutations. Each
  // mutation must observe the previous committed count rather than overwrite it.
  await recordTransportSuccess("fcm", "fcm");
  await Promise.all(
    Array.from({ length: 10 }, () =>
      recordTransportFailure("fcm", "fcm", { error: "concurrent", failureLimit: 99 })
    )
  );
  state = await readAlertRuntime("fcm");
  assert(state.delivery.failures.fcm === 10, `concurrent failure count is 10, got ${state.delivery.failures.fcm}`);

  console.log("alert runtime smoke: ok");
} finally {
  await clean();
}
