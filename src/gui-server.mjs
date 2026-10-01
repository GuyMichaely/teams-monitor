// Diagnostics layer around the runtime GUI/tunnel server.
// Logs connection behavior without logging GUI_TOKEN/access_token values.

import { join } from "node:path";
import { DATA_DIR } from "./state.mjs";
import { startGui as startRuntimeGui } from "./gui-server-runtime.mjs";
import { authOk, logDiagnostic, redactSecrets, requestMeta, tailLines, tokenMatches } from "./gui-diagnostics.mjs";
import { DASHBOARD_PAGE } from "./dashboard-page.mjs";
import { readPoll } from "./poll-status.mjs";
import { replyPolicy, validateReplyPolicy } from "./reply-policy.mjs";
import { dashboardHealth } from "./dashboard-health.mjs";
import { supervisorStatus } from './supervisor-status.mjs';
import { controlState, recordTransportSuccess, saveFcmRegistration } from "./alert-runtime.mjs";
import { loadConfig, saveConfig, currentConfig } from "./context.mjs";
import { agentStore } from './agent/store.mjs';
import { agentAPI } from './agent/api.mjs';
import { ownerActive } from './agent/owner.mjs';
import { assertActionAuthority } from './agent/executor.mjs';
import { getTeamsPresence, setTeamsPresence } from "./teams-presence.mjs";
import { activityView, clearActivityThrough, restoreActivity } from "./activity-view.mjs";
import { createScheduleStore } from './scheduled-actions.mjs';
import { orchestratorStatus } from './gui-server-core.mjs';
import { teamsOperation } from './teams-broker.mjs';

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

export function startGui(config, presence = { get: getTeamsPresence, set: setTeamsPresence }, brokerIO) {
  if (process.env.TEAMS_MONITOR_DEV === '1' && config.port !== 29222) throw new Error('Development GUI requires mock Teams CDP port 29222.');
  const result = startRuntimeGui(config);
  const { server } = result;
  const runtimeHandler = server.listeners("request")[0];
  server.removeListener("request", runtimeHandler);
  const g = config?.gui || {};
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"] || null;
  let schedules, agent;
  server.once('close', () => { schedules?.close(); agent?.close(); });

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
    // A GUI can outlive delivery-setting changes; never restore startup policy.
    loadConfig().then(live => recordTransportSuccess("websocket", live?.alerts?.transport || "websocket")).catch((e) => {
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

    if (url.pathname.startsWith('/api/agent/')) {
      if (token && !authOk(req.headers.authorization, token)) return sendJson(res, 401, { error: 'unauthorized' });
      try {
        agent ||= agentStore();
        res.setHeader('Cache-Control', 'no-store');
        const body = ['POST', 'PUT'].includes(req.method) ? await readJsonBody(req, 262144) : {};
        const health = url.pathname === '/api/agent/status' ? await orchestratorStatus((await loadConfig()).pollIntervalMs) : null;
        return sendJson(res, 200, await agentAPI({ url, method: req.method, body, store: agent, running: !!health?.running }));
      } catch (error) { return sendJson(res, 400, { ok: false, error: error.code ? error.message : 'Invalid agent request.', code: error.code, locations: error.details?.locations }); }
    }

    if (url.pathname === '/api/teams/operation') {
      if (token && !authOk(req.headers.authorization, token)) return sendJson(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try { return sendJson(res, 200, await teamsOperation(await readJsonBody(req, 65536), brokerIO)); }
      catch (error) { return sendJson(res, 409, { error: 'Teams operation not confirmed.', scheduleCode: error.scheduleCode }); }
    }

    if (url.pathname === '/api/schedules' || /^\/api\/schedules\/[^/]+\/cancel$/.test(url.pathname)) {
      try {
        if (token && !authOk(req.headers.authorization, token)) return sendJson(res, 401, { error: 'unauthorized' });
        schedules ||= createScheduleStore();
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/api/schedules' && req.method === 'GET') {
          const cfg = await loadConfig();
          return sendJson(res, 200, { jobs: schedules.list(), orchestrator: await orchestratorStatus(cfg.pollIntervalMs) });
        }
        if (url.pathname === '/api/schedules' && req.method === 'POST') {
          const job = schedules.create(await readJsonBody(req, 65536));
          logDiagnostic('schedule_created', { scheduleId: job.id, action: job.kind, dueAt: job.dueAt });
          return sendJson(res, 201, job);
        }
        if (url.pathname.endsWith('/cancel') && req.method === 'POST') {
          const job = schedules.cancel(url.pathname.split('/')[3]);
          logDiagnostic('schedule_cancelled', { scheduleId: job.id });
          return sendJson(res, 200, job);
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      } catch (e) { return sendJson(res, e.httpCode || 500, { error: e.httpCode ? e.message : 'Schedule storage unavailable; no changes confirmed.' }); }
    }

    if (url.pathname === "/api/activity/view") {
      try {
        if (token && !authOk(req.headers.authorization, token)) return sendJson(res, 401, { error: "unauthorized" });
        if (req.method === "GET" && url.pathname === "/api/activity/view") return sendJson(res, 200, activityView());
        if (req.method === "PUT") {
          const { through } = await readJsonBody(req);
          const result = through === null ? restoreActivity() : clearActivityThrough(through);
          logDiagnostic("activity_filter_changed", result);
          return sendJson(res, 200, result);
        }
        return sendJson(res, 405, { error: "method not allowed" });
      } catch (e) { return sendJson(res, e.httpCode || 500, { error: e.message }); }
    }

    if (url.pathname === "/api/teams/presence") {
      try {
        if (token && !authOk(req.headers.authorization, token)) return sendJson(res, 401, { error: "unauthorized" });
        if (req.method === "GET") return sendJson(res, 200, await presence.get(config.port || 9222));
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          if (body.expiresAt !== undefined && (!Number.isSafeInteger(body.expiresAt) || body.expiresAt > Date.now() + 300000))
            return sendJson(res, 400, { error: 'Invalid status execution deadline.' });
          if (!ownerActive(body.owner)) return sendJson(res, 409, { error: 'Orchestrator owner is no longer active.' });
          if (body.action) { agent ||= agentStore(); assertActionAuthority(body.action, await loadConfig(), agent); }
          const result = await presence.set(body.status, config.port || 9222, { expiresAt: body.expiresAt ?? Infinity,
            valid: () => {
              if (!ownerActive(body.owner)) return false;
              try { if (body.action) assertActionAuthority(body.action, currentConfig(), agent); return true; }
              catch { return false; }
            } });
          logDiagnostic(result.superseded ? "teams_presence_superseded" : "teams_presence_changed", { requested: result.requested, previous: result.previous, status: result.status, verified: result.verified });
          return sendJson(res, 200, result);
        }
        return sendJson(res, 405, { error: "method not allowed" });
      } catch (e) {
        logDiagnostic("teams_presence_failed", { error: e.message });
        return sendJson(res, e.httpCode || 503, { ok: false, error: e.message });
      }
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(DASHBOARD_PAGE);
    }

    if (["/api/reply-policy", "/api/poll", "/api/health/status", "/api/supervisor/status"].includes(url.pathname)) {
      try {
        if (token && !authOk(req.headers.authorization, token)) return sendJson(res, 401, { error: "unauthorized" });
        if (url.pathname === '/api/supervisor/status' && req.method === 'GET') {
          res.setHeader('Cache-Control', 'no-store');
          return sendJson(res, 200, await supervisorStatus());
        }
        if (url.pathname === "/api/poll" && req.method === "GET") return sendJson(res, 200, await readPoll());
        if (url.pathname === "/api/health/status" && req.method === "GET") return sendJson(res, 200, await dashboardHealth(await loadConfig()));
        if (url.pathname === "/api/reply-policy") {
          if (req.method === "GET") return sendJson(res, 200, replyPolicy(await loadConfig()));
          if (req.method === "PUT") {
            const policy = validateReplyPolicy(await readJsonBody(req));
            const cfg = await loadConfig();
            cfg.replyPolicy = policy;
            // Legacy readers must never interpret blacklist entries as permission.
            cfg.whitelist = { ...(cfg.whitelist || {}), autoSend: policy.mode === "whitelist" ? policy.entries : [] };
            await saveConfig(cfg);
            return sendJson(res, 200, policy);
          }
        }
        return sendJson(res, 405, { error: "method not allowed" });
      } catch (e) { return sendJson(res, e.httpCode || 500, { error: e.message }); }
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

    return runtimeHandler(req, res);
  });

  return result;
}
