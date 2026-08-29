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
    rm(RUNTIME_LOCK_FILE, { recursive: true, force: true }),
    rm(FCM_REGISTRATION_FILE, { force: true }),
    rm(REGISTRATION_LOCK_FILE, { recursive: true, force: true }),
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

  // Explicit recovery policy: one successful primary send is enough.
  state = await recordTransportSuccess("fcm", "fcm");
  assert(state.delivery.state === "primary_working", "one FCM success recovers primary");
  assert(state.websocketWanted === false, "one FCM success releases recovery WS");

  state = await recordFcmBackoff("fcm", { error: "quota", delayMs: 60_000 });
  assert(state.fcm.backoffMs === 60_000, "FCM backoff duration is persisted");
  assert(Date.parse(state.fcm.nextAttemptAt) > Date.now(), "FCM next-attempt timestamp is in the future");

  state = await recordTransportSuccess("fcm", "fcm");
  assert(state.fcm.backoffMs === 0, "FCM success clears retry backoff");
  assert(state.fcm.nextAttemptAt === null, "FCM success clears next-attempt timestamp");

  // No registration at send time is itself a generation (-1). If a registration
  // appears before that result is recorded, the obsolete result must be ignored.
  state = await markFcmRegistrationSuspect("fcm", "missing", { registrationGeneration: -1 });
  assert(state.delivery.state === "fallback", "missing registration enters fallback while still missing");

  await saveFcmRegistration({
    fid: "smoke-fid-123456789",
    source: "smoke",
    observedAt: "2026-08-29T00:00:00.000Z",
  });
  let registration = await readFcmRegistration();
  assert(registration?.kind === "fid", "FID registration persisted");
  assert(registration?.value === "smoke-fid-123456789", "FID registration value round-trips");
  assert(registration?.generation === 1, "first FID gets generation 1");
  const generation1 = registration.generation;

  state = await recordTransportSuccess("fcm", "fcm", {
    registrationGeneration: generation1,
  });
  assert(state.delivery.state === "primary_working", "current generation can recover FCM");
  assert(state.websocketWanted === false, "current-generation recovery releases WS");

  // A queued duplicate upload of the same FID must not clear a later
  // UNREGISTERED result for that same generation.
  state = await markFcmRegistrationSuspect("fcm", "UNREGISTERED", {
    registrationGeneration: generation1,
  });
  assert(state.fcm.registration === "suspect", "current FID generation can be marked suspect");
  await saveFcmRegistration({
    fid: "smoke-fid-123456789",
    source: "duplicate",
    observedAt: "2026-08-29T00:00:30.000Z",
  });
  registration = await readFcmRegistration();
  state = await readAlertRuntime("fcm");
  assert(registration?.generation === generation1, "same FID keeps the same generation");
  assert(state.fcm.registration === "suspect", "same-FID duplicate does not clear suspect state");
  assert(state.delivery.state === "fallback", "same-FID duplicate does not leave fallback");

  // A genuinely new FID is a new generation. It repairs registration identity,
  // but fallback remains until an FCM send against that generation succeeds.
  await saveFcmRegistration({
    fid: "smoke-fid-newer-123456789",
    source: "smoke-newer",
    observedAt: "2026-08-29T00:02:00.000Z",
  });
  registration = await readFcmRegistration();
  const generation2 = registration.generation;
  state = await readAlertRuntime("fcm");
  assert(generation2 === generation1 + 1, "new FID increments registration generation");
  assert(state.fcm.registration === "synced", "new FID replaces suspect registration state");
  assert(state.delivery.state === "fallback", "new FID alone does not claim delivery recovery");

  const staleInvalidation = await markFcmRegistrationSuspect("fcm", "old-send-unregistered", {
    registrationGeneration: generation1,
  });
  state = await readAlertRuntime("fcm");
  assert(staleInvalidation.ignoredStaleFcmResult === true, "old-generation invalidation is ignored");
  assert(state.fcm.registration === "synced", "old-generation invalidation cannot poison new FID");

  const staleSuccess = await recordTransportSuccess("fcm", "fcm", {
    registrationGeneration: generation1,
  });
  state = await readAlertRuntime("fcm");
  assert(staleSuccess.ignoredStaleFcmResult === true, "old-generation success is ignored");
  assert(state.delivery.state === "fallback", "old-generation success cannot recover new FID");

  state = await recordTransportSuccess("fcm", "fcm", {
    registrationGeneration: generation2,
  });
  assert(state.delivery.state === "primary_working", "one current-generation FCM success restores primary");
  assert(state.websocketWanted === false, "one current-generation FCM success shuts down fallback WS");

  // If another FID arrives later, results from generation 2 must no longer be
  // able to alter its health.
  await markFcmRegistrationSuspect("fcm", "force-recovery", {
    registrationGeneration: generation2,
  });
  await saveFcmRegistration({
    fid: "smoke-fid-third-123456789",
    source: "smoke-third",
    observedAt: "2026-08-29T00:03:00.000Z",
  });
  registration = await readFcmRegistration();
  const generation3 = registration.generation;
  const staleGeneration2Success = await recordTransportSuccess("fcm", "fcm", {
    registrationGeneration: generation2,
  });
  state = await readAlertRuntime("fcm");
  assert(staleGeneration2Success.ignoredStaleFcmResult === true, "prior-generation success is ignored after FID change");
  assert(state.delivery.state === "fallback", "prior-generation success cannot recover newest FID");

  state = await recordTransportSuccess("fcm", "fcm", {
    registrationGeneration: generation3,
  });
  assert(state.delivery.state === "primary_working", "newest-generation success restores FCM");

  const staleResult = await saveFcmRegistration({
    fid: "smoke-fid-stale-123456789",
    source: "smoke-stale",
    observedAt: "2026-08-29T00:01:00.000Z",
  });
  registration = await readFcmRegistration();
  assert(staleResult?.ignoredStale === true, "older different FID is rejected as stale");
  assert(registration?.value === "smoke-fid-third-123456789", "stale FID cannot replace newer registration");

  // Registration requests can complete in any network order. The registration
  // lock + observedAt comparison must make the newest observation win anyway.
  await Promise.all([
    saveFcmRegistration({ fid: "smoke-fid-t5-123456789", source: "concurrent", observedAt: "2026-08-29T00:05:00.000Z" }),
    saveFcmRegistration({ fid: "smoke-fid-t3b-123456789", source: "concurrent", observedAt: "2026-08-29T00:03:30.000Z" }),
    saveFcmRegistration({ fid: "smoke-fid-t4-123456789", source: "concurrent", observedAt: "2026-08-29T00:04:00.000Z" }),
  ]);
  registration = await readFcmRegistration();
  assert(registration?.value === "smoke-fid-t5-123456789", "newest concurrent FID observation wins");

  // Exercise the cross-process runtime lock with concurrent mutations. Each
  // mutation must observe the previous committed count rather than overwrite it.
  await recordTransportSuccess("fcm", "fcm", {
    registrationGeneration: registration.generation,
  });
  await Promise.all(
    Array.from({ length: 10 }, () =>
      recordTransportFailure("fcm", "fcm", {
        error: "concurrent",
        failureLimit: 99,
        registrationGeneration: registration.generation,
      })
    )
  );
  state = await readAlertRuntime("fcm");
  assert(state.delivery.failures.fcm === 10, `concurrent failure count is 10, got ${state.delivery.failures.fcm}`);

  console.log("alert runtime smoke: ok");
} finally {
  await clean();
}
