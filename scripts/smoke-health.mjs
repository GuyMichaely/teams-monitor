import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../src/state.mjs";
import { checkPublicTunnel } from "../src/tunnel-health.mjs";
import { sendPhoneHealth } from "../src/phone-health.mjs";

const STATE_FILE = join(DATA_DIR, "tunnel-health.json");
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

await rm(STATE_FILE, { force: true });
try {
  assert(typeof sendPhoneHealth === "function", "health FCM sender imports successfully");

  globalThis.fetch = async () => new Response("ok", { status: 200 });
  let result = await checkPublicTunnel(config(), { force: true });
  assert(result.reachable === true, "healthy public route is reachable");
  assert(result.status === null, "initial healthy observation does not emit recovery");

  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === false, "repeated healthy observation is not a transition");

  globalThis.fetch = async () => new Response("down", { status: 503 });
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.reachable === false, "non-2xx public route is unavailable");
  assert(result.changed === true && result.status === "missing", "failure transition opens incident");

  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === false, "repeated tunnel failure is not a new transition");

  globalThis.fetch = async () => new Response("ok", { status: 200 });
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === true && result.status === "recovered", "healthy transition closes incident");

  globalThis.fetch = async () => { throw new Error("network down"); };
  result = await checkPublicTunnel(config(), { force: true });
  assert(result.changed === true && result.status === "missing", "network exception opens incident");

  result = await checkPublicTunnel(config(""), { force: true });
  assert(result.configured === false, "empty health URL disables tunnel monitoring");
  assert(result.changed === true && result.status === "recovered", "disabling an active incident resolves it");

  console.log("health monitor smoke: ok");
} finally {
  globalThis.fetch = originalFetch;
  await rm(STATE_FILE, { force: true });
}
