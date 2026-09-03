// Diagnostics layer around the runtime GUI/tunnel server.
// Logs connection behavior without logging GUI_TOKEN/access_token values.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./state.mjs";
import { startGui as startRuntimeGui } from "./gui-server-runtime.mjs";
import { authOk, logDiagnostic, redactSecrets, requestMeta, tailLines, tokenMatches } from "./gui-diagnostics.mjs";
import { injectObservability } from "./gui-observability-ui.mjs";
import { injectPolicyUi } from "./gui-policy-ui.mjs";
import { injectAbsoluteLogTime } from "./gui-absolute-log-time-ui.mjs";
import { injectDashboardLayout } from "./gui-dashboard-layout.mjs";
import { controlState, recordTransportSuccess, saveFcmRegistration } from "./alert-runtime.mjs";
import { loadConfig } from "./context.mjs";
import { validateDeterministicRules } from "./deterministic-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "config", "config.json");
const TUNNEL_LOG = join(DATA_DIR, "tunnel.log");
const TUNNEL_OUT_LOG = join(DATA_DIR, "tunnel.out.log");

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req, cap = 16_384) {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > cap) {
      throw Object.assign(new Error("payload too large"), { httpCode: 400 });
    }
  }
  try { return JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("invalid JSON"), { httpCode: 400 }); }
}

async function diagnostics(limit) {
  const events = tailLines(join(DATA_DIR, "gui-diagnostics.jsonl"), limit).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: redactSecrets(line) }; }
  });
  let alertDelivery = null;
  try {
    alertDelivery = await controlState(await loadConfig());
  } catch (e) {
    alertDelivery = { error: e.message };
  }
  return {
    generatedAt: new Date().toISOString(),
    serverPid: process.pid,
    alertDelivery,
    events,
    tunnelLog: tailLines(TUNNEL_LOG, limit).map(redactSecrets),
    tunnelOutLog: tailLines(TUNNEL_OUT_LOG, limit).map(redactSecrets),
  };
}

async function getPolicyRules() {
  const cfg = await loadConfig();
  try { return validateDeterministicRules(cfg.automation?.rules || []); }
  catch { return []; }
}

async function putPolicyRules(body) {
  const rules = validateDeterministicRules(body?.rules);
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.automation = { ...(cfg.automation || {}), rules };
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  return rules;
}

function decoratePage(page) {
  return injectDashboardLayout(injectAbsoluteLogTime(injectPolicyUi(injectObservability(page))));
}

export function startGui(config) {
  const result = startRuntimeGui(config);
  const { server } = result;
  const runtimeHandler = server.listeners("request")[0];
  server.removeListener("request", runtimeHandler);
  const g = config?.gui || {};
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"] || null;
  const primaryTransport = config?.alerts?.transport || "websocket";

  logDiagnostic("gui_started", {
    pid: process.pid,
    host: g.host || "127.0.0.1",
    port: g.port || 8090,
    tokenConfigured: !!token,
  });

  // Core WebSocket upgrade handling is already installed. This observer runs
  // afterward and records whether the same request was accepted or rejected.
  server.on("upgrade", (req, socket) => {
    const startedAt = Date.now();
    const meta = requestMeta(req);
    let url;
    try { url = new URL(req.url, "http://x"); } catch { url = new URL("http://x/"); }
    const tokenSupplied = url.searchParams.has("access_token");
    let reason = null;

    if (url.pathname !== "/ws/alerts") reason = "wrong-path";
    else if (token && !tokenMatches(url.searchParams.get("access_token") || "", token)) reason = "unauthorized";
    else if (!req.headers["sec-websocket-key"]) reason = "missing-websocket-key";
    else if (socket.destroyed) reason = "socket-destroyed-during-upgrade";

    if (reason) {
      logDiagnostic("ws_rejected", { ...meta, reason, tokenConfigured: !!token, tokenSupplied });
      return;
    }

    logDiagnostic("ws_connected", { ...meta, tokenConfigured: !!token, tokenSupplied });
    recordTransportSuccess("websocket", primaryTransport).catch((e) => {
      logDiagnostic("ws_state_update_failed", { ...meta, error: e.message });
    });
    socket.on("error", (e) => logDiagnostic("ws_socket_error", { ...meta, error: e.message }));
    socket.once("close", (hadError) => {
      logDiagnostic("ws_disconnected", {
        ...meta,
        hadError: !!hadError,
        durationMs: Date.now() - startedAt,
      });
    });
  });

  server.on("request", async (req, res) => {
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/api/policy/rules") {
      try {
        if (token && !authOk(req.headers.authorization, token)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
        }
        if (req.method === "GET") {
          return sendJson(res, 200, { ok: true, rules: await getPolicyRules() });
        }
        if (req.method === "PUT") {
          const rules = await putPolicyRules(await readJsonBody(req));
          return sendJson(res, 200, { ok: true, rules });
        }
        return sendJson(res, 405, { ok: false, error: "method not allowed" });
      } catch (e) {
        return sendJson(res, e.httpCode || 400, { ok: false, error: e.message });
      }
    }

    if (url.pathname === "/api/diagnostics") {
      if (token && !authOk(req.headers.authorization, token)) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 120, 1), 500);
      return sendJson(res, 200, await diagnostics(limit));
    }

    if (url.pathname === "/api/alerts" || url.pathname === "/api/fcm/register" || url.pathname === "/api/control/sync" || url.pathname === "/api/tunnel/start" || url.pathname === "/api/tunnel/stop") {
      const meta = requestMeta(req);
      const startedAt = Date.now();
      res.once("finish", () => {
        const kind = url.pathname === "/api/alerts"
          ? "alert_http"
          : url.pathname === "/api/fcm/register"
            ? "fcm_register_http"
            : url.pathname === "/api/control/sync"
              ? "control_sync_http"
              : "tunnel_control_http";
        logDiagnostic(kind, {
          ...meta,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });
    }

    // New FID-aware registration endpoint. Intercept it before the legacy
    // runtime layer, which still accepts registration tokens during migration.
    if (req.method === "POST" && url.pathname === "/api/fcm/register") {
      try {
        if (token && !authOk(req.headers.authorization, token)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
        }
        const body = await readJsonBody(req);
        const registration = await saveFcmRegistration({
          fid: body.fid,
          token: body.token,
          source: "phone-direct",
          observedAt: body.observedAt,
        });
        return sendJson(res, 200, {
          ok: true,
          registered: true,
          kind: registration.kind,
          generation: registration.generation,
          updatedAt: registration.updatedAt,
        });
      } catch (e) {
        return sendJson(res, e.httpCode || 500, { ok: false, error: e.message });
      }
    }

    // Phone control/safety synchronization. The phone may include its current
    // FID so this route also repairs a missed registration upload.
    if (req.method === "POST" && url.pathname === "/api/control/sync") {
      try {
        if (token && !authOk(req.headers.authorization, token)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
        }
        const body = await readJsonBody(req);
        if (typeof body.fid === "string" && body.fid.trim()) {
          await saveFcmRegistration({
            fid: body.fid,
            source: "phone-control-sync",
            observedAt: body.registrationUpdatedAt,
          });
        }
        const liveConfig = await loadConfig();
        return sendJson(res, 200, { ok: true, ...(await controlState(liveConfig)) });
      } catch (e) {
        return sendJson(res, e.httpCode || 500, { ok: false, error: e.message });
      }
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const runtimeEnd = res.end.bind(res);
      res.end = (chunk, encoding, callback) => {
        let body = chunk;
        if (typeof chunk === "string") body = decoratePage(chunk);
        else if (Buffer.isBuffer(chunk)) body = Buffer.from(decoratePage(chunk.toString("utf8")));
        return runtimeEnd(body, encoding, callback);
      };
    }

    return runtimeHandler(req, res);
  });

  return result;
}
