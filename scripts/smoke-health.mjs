import { rm } from "node:fs/promises";
import {
  TUNNEL_HEALTH_FILE,
  checkPublicTunnel,
  markPublicTunnelReported,
} from "../src/tunnel-health.mjs";
import { sendPhoneHealth } from "../src/phone-health.mjs";

const originalFetch = globalThis.fetch;

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function config(url = "https://health.example/") {
  return {
    controlWorker: {
      publicHealthUrl: url,
      heartbeatIntervalMs: 10_000,
    },
  };
}

await rm(TUNNEL_HEALTH_FILE, { force: true });
try {
  assert(typeof sendPhoneHealth === "function", "health FCM sender imports successfully");

  globalThis.fetch = async () => new Response("ok", { status: 200 });
  let result = await checkPublicTunnel(config(), { force: true });
  assert(result.reachable === true, "healthy public route is reachable");
  assert(result.status === null, "initial healthy observation does not emit recovery");
  assert(result.needsReport === false, "initial healthy state establishes report baseline");

  globalThis.fetch = async () => new Response("down", { status: 503 });
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === true && result.status === "missing", "failure transition opens incident");
  assert(result.needsReport === true, "new failure requires a phone report");

  // Simulate an FCM send failure by deliberately not acknowledging the report.
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === false, "repeated failure is not a new observation transition");
  assert(result.needsReport === true, "undelivered failure remains reportable");

  assert(await markPublicTunnelReported("missing"), "successful missing report can be acknowledged");
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.needsReport === false, "reported failure is not duplicated");

  globalThis.fetch = async () => new Response("ok", { status: 200 });
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === true && result.status === "recovered", "healthy transition closes incident");
  assert(result.needsReport === true, "recovery after a reported failure requires a phone report");

  // Recovery must also retry until delivery succeeds.
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.needsReport === true, "undelivered recovery remains reportable");
  assert(await markPublicTunnelReported("recovered"), "successful recovery report can be acknowledged");
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.needsReport === false, "reported recovery is not duplicated");

  // A failure that was never reported should not produce a meaningless recovery.
  globalThis.fetch = async () => { throw new Error("network down"); };
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.needsReport === true && result.status === "missing", "network exception opens reportable incident");
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.status === "recovered", "observation recovers");
  assert(result.needsReport === false, "unreported incident recovery needs no phone report");

  // If the phone was told the tunnel was missing, disabling the probe must report
  // recovery and must retain that report until delivery succeeds.
  globalThis.fetch = async () => new Response("down", { status: 503 });
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.needsReport === true, "failure before disable is reportable");
  assert(await markPublicTunnelReported("missing"), "failure before disable is marked reported");
  result = await checkPublicTunnel(config(""), { force: true });
  assert(result.configured === false, "empty health URL disables tunnel monitoring");
  assert(result.status === "recovered" && result.needsReport === true, "disabling a reported incident resolves it");
  result = await checkPublicTunnel(config(""), { force: true });
  assert(result.needsReport === true, "disabled-state recovery retries until delivered");
  assert(await markPublicTunnelReported("recovered"), "disabled-state recovery can be marked delivered");
  result = await checkPublicTunnel(config(""), { force: true });
  assert(result.needsReport === false, "delivered disabled-state recovery is not repeated");

  console.log("health monitor smoke: ok");
} finally {
  globalThis.fetch = originalFetch;
  await rm(TUNNEL_HEALTH_FILE, { force: true });
}
