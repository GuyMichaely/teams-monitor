import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./local-paths.mjs";
import { alertClientCount } from "./gui-server-core.mjs";

let probe = null;
let checkedAt = 0;
export async function dashboardHealth(config) {
  if (!probe || Date.now() - checkedAt > 10_000) {
    checkedAt = Date.now();
    probe = (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${Number(config.port) || 9222}/json/list`, { signal: AbortSignal.timeout(1500) });
        const targets = response.ok ? await response.json() : [];
        return { connected: targets.some((t) => t.type === "page" && String(t.url).includes("teams.microsoft.com")), checkedAt: new Date().toISOString() };
      } catch { return { connected: false, checkedAt: new Date().toISOString() }; }
    })();
  }
  let tunnel = null;
  try { tunnel = JSON.parse(await readFile(join(DATA_DIR, "tunnel-health.json"), "utf8")); } catch {}
  return { teams: await probe, websocketClients: alertClientCount(), tunnel,
    brain: { provider: config.brain?.provider || "stub", model: config.brain?.model || "", configured: config.brain?.provider === "stub" || !!process.env[config.brain?.apiKeyEnv || "GEMINI_API_KEY"] } };
}
