import { loadConfig, saveConfig } from "./context.mjs";
// Thin runtime-control layer around the dashboard server.
// The dashboard implementation lives in gui-server-core.mjs; this module adds
// local start/stop/status controls for the already-provisioned `teams-gui`
// Cloudflare tunnel. It does not create tunnels, edit DNS, or call Cloudflare APIs.

import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAlertDeliveryPolicy, startGui as startCoreGui } from "./gui-server-core.mjs";
import { requestPhonePolicySync } from "./alerts.mjs";
import { logDiagnostic } from "./gui-diagnostics.mjs";
import { DATA_DIR } from "./state.mjs";
import { controlState, registrationFileExists, saveFcmRegistration } from "./alert-runtime.mjs";
import { DEFAULT_FCM_SERVICE_ACCOUNT_FILE, resolveFcmConfig } from "./fcm-config.mjs";
import { TUNNEL_HOST, TUNNEL_NAME } from "./tunnel-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TUNNEL_LOG = join(DATA_DIR, "tunnel.log");
const TUNNEL_OUT_LOG = join(DATA_DIR, "tunnel.out.log");

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function authOk(header, token) {
  const m = /^Bearer\s+(.+)$/.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonBody(req, cap = 8192) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > cap) {
      throw Object.assign(new Error("payload too large"), { httpCode: 400 });
    }
  }
  try { return JSON.parse(body || "{}"); }
  catch { throw Object.assign(new Error("invalid JSON"), { httpCode: 400 }); }
}

function configuredFallbackTransport(alerts, primary) {
  if (Object.prototype.hasOwnProperty.call(alerts || {}, "fallbackTransport")) {
    const value = alerts.fallbackTransport;
    if (value === null || value === false || value === "none") return null;
    return String(value || "");
  }
  return primary === "fcm" ? "websocket" : "fcm";
}

async function runtimeConfig() {
  const cfg = await loadConfig();
  const fcm = cfg.alerts?.fcm || {};
  const resolvedFcm = await resolveFcmConfig(fcm);
  const transport = cfg.alerts?.transport || "websocket";
  return {
    pollIntervalMs: cfg.pollIntervalMs || 15000,
    alerts: {
      transport,
      fallbackTransport: configuredFallbackTransport(cfg.alerts, transport),
      fcmProjectId: resolvedFcm.projectId,
      fcmRegistrationPresent: registrationFileExists(),
      fcmServiceAccountPresent: resolvedFcm.serviceAccountPresent,
      fcmServiceAccountValid: resolvedFcm.serviceAccountValid,
    },
  };
}

async function saveAlertConfig(req) {
  const body = await readJsonBody(req);
  const transport = String(body.transport || "");
  if (!["websocket", "fcm"].includes(transport)) {
    throw Object.assign(new Error("transport must be websocket or fcm"), { httpCode: 400 });
  }

  const cfg = await loadConfig();
  cfg.alerts = cfg.alerts || {};
  const hasRequestedFallback = Object.prototype.hasOwnProperty.call(body, "fallbackTransport");
  const hadExplicitFallback = Object.prototype.hasOwnProperty.call(cfg.alerts, "fallbackTransport");
  let fallbackTransport = hasRequestedFallback
    ? body.fallbackTransport
    : hadExplicitFallback
      ? configuredFallbackTransport(cfg.alerts, cfg.alerts.transport || "websocket")
      : (transport === "fcm" ? "websocket" : "fcm");

  if (fallbackTransport === "none" || fallbackTransport === false) fallbackTransport = null;
  if (fallbackTransport !== null && fallbackTransport !== undefined) {
    fallbackTransport = String(fallbackTransport || "");
    if (!["websocket", "fcm"].includes(fallbackTransport)) {
      throw Object.assign(new Error("fallbackTransport must be websocket, fcm, or null"), { httpCode: 400 });
    }
    if (fallbackTransport === transport) {
      if (!hasRequestedFallback) fallbackTransport = transport === "fcm" ? "websocket" : "fcm";
      else throw Object.assign(new Error("fallbackTransport must differ from the primary transport"), { httpCode: 400 });
    }
  } else {
    fallbackTransport = null;
  }

  const nextFcm = {
    ...(cfg.alerts.fcm || {}),
    serviceAccountFile: cfg.alerts.fcm?.serviceAccountFile || DEFAULT_FCM_SERVICE_ACCOUNT_FILE,
  };
  delete nextFcm.projectId;
  const resolvedFcm = await resolveFcmConfig(nextFcm);
  if ((transport === "fcm" || fallbackTransport === "fcm") && !resolvedFcm.projectId) {
    throw Object.assign(new Error("Firebase project ID missing from service account"), { httpCode: 400 });
  }

  cfg.alerts.transport = transport;
  cfg.alerts.fallbackTransport = fallbackTransport;
  cfg.alerts.fcm = nextFcm;
  delete cfg.alerts.fcm.deviceToken;
  await saveConfig(cfg);
  const state = await controlState(cfg);
  applyAlertDeliveryPolicy(state);
  // Also wake FCM-only phones when fallback settings change without an open socket.
  // Saving must not wait on Google or imply that the phone has reconnected.
  void requestPhonePolicySync(cfg).catch(() => logDiagnostic("phone_policy_sync_failed", { code: "internal_error" }));
  return await runtimeConfig();
}

async function registerFcmRegistration(req) {
  const body = await readJsonBody(req);
  const registration = await saveFcmRegistration({
    fid: body.fid,
    token: body.token,
    source: "phone-runtime",
    observedAt: body.observedAt,
  });
  return {
    registered: true,
    kind: registration.kind,
    generation: registration.generation,
    updatedAt: registration.updatedAt,
  };
}

async function savePollInterval(req) {
  const body = await readJsonBody(req);
  const pollIntervalMs = Number(body.pollIntervalMs);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 300000) {
    throw Object.assign(new Error("pollIntervalMs must be an integer from 1000 to 300000"), { httpCode: 400 });
  }
  const cfg = await loadConfig();
  cfg.pollIntervalMs = pollIntervalMs;
  await saveConfig(cfg);
  return { pollIntervalMs };
}

function tunnelProcesses() {
  if (process.platform !== "win32") return [];
  const command =
    "$p = Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | " +
    `Where-Object { $_.CommandLine -match '(?i)tunnel\\s+run' -and $_.CommandLine -match '(?i)${TUNNEL_NAME}' } | ` +
    "Select-Object ProcessId,CommandLine; if ($p) { $p | ConvertTo-Json -Compress }";
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", windowsHide: true }
    ).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
      pid: Number(p.ProcessId),
      commandLine: p.CommandLine || "",
    }));
  } catch {
    return [];
  }
}

function tunnelStatus() {
  const processes = tunnelProcesses();
  return {
    running: processes.length > 0,
    pids: processes.map((p) => p.pid),
    name: TUNNEL_NAME,
    hostname: TUNNEL_HOST,
  };
}

function resolveCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_EXE,
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  try {
    const found = execFileSync("where.exe", ["cloudflared.exe"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch { /* fall through */ }
  throw Object.assign(
    new Error("cloudflared.exe not found; install it or set CLOUDFLARED_EXE"),
    { httpCode: 500 }
  );
}

function startTunnel() {
  const current = tunnelStatus();
  if (current.running) {
    throw Object.assign(new Error(`already running (pid ${current.pids.join(", ")})`), { httpCode: 409 });
  }
  const out = openSync(TUNNEL_OUT_LOG, "a");
  const err = openSync(TUNNEL_LOG, "a");
  let child;
  try {
    child = spawn(resolveCloudflared(), ["tunnel", "run", TUNNEL_NAME], {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: ROOT,
      windowsHide: true,
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  child.on("error", () => {});
  child.unref();
  return { pid: child.pid };
}

function stopTunnel() {
  const current = tunnelStatus();
  if (!current.running) return { killed: false, pids: [], reason: "not-running" };
  const killed = [];
  for (const pid of current.pids) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killed.push(pid);
    } catch { /* process may already have exited */ }
  }
  return {
    killed: killed.length > 0,
    pids: killed,
    reason: killed.length ? null : "kill-failed",
  };
}


export function startGui(config) {
  const result = startCoreGui(config);
  const { server } = result;
  const coreHandler = server.listeners("request")[0];
  server.removeListener("request", coreHandler);
  const g = config?.gui || {};
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"] || null;

  server.on("request", async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/tunnel/") || url.pathname === "/api/runtime/config" || url.pathname === "/api/config/poll-interval" || url.pathname === "/api/config/alerts" || url.pathname === "/api/fcm/register") {
      try {
        if (token && !authOk(req.headers.authorization, token)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
        }
        if (req.method === "GET" && url.pathname === "/api/runtime/config") {
          return sendJson(res, 200, await runtimeConfig());
        }
        if (req.method === "PUT" && url.pathname === "/api/config/poll-interval") {
          return sendJson(res, 200, { ok: true, ...(await savePollInterval(req)) });
        }
        if (req.method === "PUT" && url.pathname === "/api/config/alerts") {
          return sendJson(res, 200, await saveAlertConfig(req));
        }
        if (req.method === "POST" && url.pathname === "/api/fcm/register") {
          return sendJson(res, 200, { ok: true, ...(await registerFcmRegistration(req)) });
        }
        if (req.method === "GET" && url.pathname === "/api/tunnel/status") {
          return sendJson(res, 200, tunnelStatus());
        }
        if (req.method === "POST" && url.pathname === "/api/tunnel/start") {
          return sendJson(res, 200, { ok: true, ...startTunnel() });
        }
        if (req.method === "POST" && url.pathname === "/api/tunnel/stop") {
          return sendJson(res, 200, { ok: true, ...stopTunnel() });
        }
        return sendJson(res, 404, { ok: false, error: "not found" });
      } catch (e) {
        return sendJson(res, e.httpCode || 500, { ok: false, error: e.message });
      }
    }

    return coreHandler(req, res);
  });

  return result;
}
