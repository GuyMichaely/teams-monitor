// Thin runtime-control layer around the dashboard server.
// The dashboard implementation lives in gui-server-core.mjs; this module adds
// local start/stop/status controls for the already-provisioned `teams-gui`
// Cloudflare tunnel. It does not create tunnels, edit DNS, or call Cloudflare APIs.

import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGui as startCoreGui } from "./gui-server-core.mjs";
import { DATA_DIR } from "./state.mjs";
import { DEFAULT_FCM_SERVICE_ACCOUNT_FILE, resolveFcmConfig } from "./fcm-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "config", "config.json");
const FCM_DEVICE_TOKEN_FILE = join(DATA_DIR, "fcm-device-token.txt");
const TUNNEL_NAME = "teams-gui";
const TUNNEL_HOST = "gui.guymichaely.com";
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

async function runtimeConfig() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  const fcm = cfg.alerts?.fcm || {};
  const resolvedFcm = await resolveFcmConfig(fcm);
  let fcmTokenRegistered = false;
  try { fcmTokenRegistered = !!(await readFile(FCM_DEVICE_TOKEN_FILE, "utf8")).trim(); } catch { /* no token */ }
  return {
    pollIntervalMs: cfg.pollIntervalMs || 15000,
    mode: cfg.automation?.mode || "respond",
    alerts: {
      transport: cfg.alerts?.transport || "websocket",
      fcmProjectId: resolvedFcm.projectId,
      fcmProjectIdOverride: resolvedFcm.projectIdOverride,
      fcmProjectIdSource: resolvedFcm.projectIdSource,
      fcmTokenRegistered,
      fcmServiceAccountPresent: resolvedFcm.serviceAccountPresent,
      fcmServiceAccountValid: resolvedFcm.serviceAccountValid,
    },
  };
}

async function saveAlertConfig(req) {
  const body = await readJsonBody(req);
  const transport = String(body.transport || "");
  const projectId = String(body.projectId || "").trim();
  if (!["websocket", "fcm"].includes(transport)) {
    throw Object.assign(new Error("transport must be websocket or fcm"), { httpCode: 400 });
  }
  if (projectId.length > 128) {
    throw Object.assign(new Error("Firebase project ID is too long"), { httpCode: 400 });
  }
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.alerts = cfg.alerts || {};
  const nextFcm = {
    ...(cfg.alerts.fcm || {}),
    projectId,
    serviceAccountFile: cfg.alerts.fcm?.serviceAccountFile || DEFAULT_FCM_SERVICE_ACCOUNT_FILE,
  };
  const resolvedFcm = await resolveFcmConfig(nextFcm);
  if (transport === "fcm" && !resolvedFcm.projectId) {
    throw Object.assign(
      new Error("Firebase project ID missing from both override and service account"),
      { httpCode: 400 }
    );
  }
  cfg.alerts.transport = transport;
  cfg.alerts.fcm = nextFcm;
  delete cfg.alerts.fcm.deviceToken;
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "
");
  return await runtimeConfig();
}

async function registerFcmToken(req) {
  const body = await readJsonBody(req);
  const deviceToken = typeof body.token === "string" ? body.token.trim() : "";
  if (deviceToken.length < 20 || deviceToken.length > 4096) {
    throw Object.assign(new Error("invalid FCM registration token"), { httpCode: 400 });
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FCM_DEVICE_TOKEN_FILE, deviceToken + "\n", { mode: 0o600 });
  return { registered: true };
}

async function savePollInterval(req) {
  const body = await readJsonBody(req);
  const pollIntervalMs = Number(body.pollIntervalMs);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 300000) {
    throw Object.assign(new Error("pollIntervalMs must be an integer from 1000 to 300000"), { httpCode: 400 });
  }
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.pollIntervalMs = pollIntervalMs;
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  return { pollIntervalMs };
}

function tunnelProcesses() {
  if (process.platform !== "win32") return [];
  const command =
    "$p = Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | " +
    "Where-Object { $_.CommandLine -match '(?i)tunnel\\s+run' -and $_.CommandLine -match '(?i)teams-gui' } | " +
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

const TUNNEL_HTML = `
  <h2>Runtime</h2>
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div class="row">
        <span id="statusDot" class="dot" style="background:var(--dim)"></span>
        <strong>Teams orchestrator</strong>
        <span id="statusText" style="color:var(--dim)">checking…</span>
      </div>
      <div class="row">
        <button id="btnStart" onclick="startOrch()" disabled>Start</button>
        <button id="btnStop" class="danger" onclick="stopOrch()" disabled>Stop</button>
      </div>
    </div>

    <div class="row" style="justify-content:space-between;border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <div class="row">
        <span id="tunnelDot" class="dot" style="background:var(--dim)"></span>
        <strong>Cloudflare tunnel</strong>
        <span id="tunnelText" style="color:var(--dim)">checking…</span>
      </div>
      <div class="row">
        <button id="btnTunnelStart" onclick="startCloudflareTunnel()" disabled>Start</button>
        <button id="btnTunnelStop" class="danger" onclick="stopCloudflareTunnel()" disabled>Stop</button>
      </div>
    </div>

    <div class="row" style="justify-content:space-between;border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <div>
        <strong>Polling interval</strong>
        <div style="color:var(--dim);font-size:12px">Applies live; no orchestrator restart required.</div>
      </div>
      <div class="row">
        <input id="pollIntervalSec" type="number" min="1" max="300" step="0.5"
          style="width:90px;background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
        <span style="color:var(--dim)">seconds</span>
        <button class="secondary" onclick="savePollInterval()">Save</button>
      </div>
    </div>

    <div style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <div class="row" style="justify-content:space-between">
        <div>
          <strong>Phone notification transport</strong>
          <div style="color:var(--dim);font-size:12px">Exactly one transport sends each alarm.</div>
        </div>
        <div class="row">
          <select id="alertTransport" onchange="renderAlertTransportFields()"
            style="background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
            <option value="websocket">WebSocket</option>
            <option value="fcm">Firebase Cloud Messaging</option>
          </select>
          <button class="secondary" onclick="saveAlertTransport()">Save</button>
        </div>
      </div>
      <div id="fcmFields" style="margin-top:10px">
        <div class="row">
          <input id="fcmProjectId" type="text" placeholder="Optional Firebase project ID override"
            style="min-width:260px;background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          <span id="fcmStatus" style="color:var(--dim);font-size:12px"></span>
        </div>
      </div>
    </div>

    <p style="color:var(--dim);font-size:12px;margin:10px 0 0">
      The tunnel exposes gui.guymichaely.com to this GUI and the phone app. Stopping it remotely disconnects both.
    </p>
  </div>
`;

const TUNNEL_SCRIPT = `<script>
async function tunnelApi(path, opts = {}) {
  const tunnelToken = localStorage.guiToken || "";
  const res = await fetch(path, { ...opts,
    headers: { ...(tunnelToken ? { "Authorization": "Bearer " + tunnelToken } : {}), ...(opts.headers || {}) } });
  if (res.status === 401) { if (typeof showLogin === "function") showLogin(); throw new Error("unauthorized"); }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
}
function renderTunnelStatus(s) {
  const dot = document.getElementById("tunnelDot");
  const text = document.getElementById("tunnelText");
  if (!dot || !text) return;
  dot.style.background = s.running ? "var(--ok)" : "var(--bad)";
  text.textContent = s.running ? "running · pid " + s.pids.join(", ") : "stopped";
  document.getElementById("btnTunnelStart").disabled = s.running;
  document.getElementById("btnTunnelStop").disabled = !s.running;
}
function applyRuntimeConfig(c) {
  const input = document.getElementById("pollIntervalSec");
  if (input && document.activeElement !== input) input.value = String(c.pollIntervalMs / 1000);
  const transport = c.alerts?.transport || "websocket";
  const transportSelect = document.getElementById("alertTransport");
  if (transportSelect && document.activeElement !== transportSelect) transportSelect.value = transport;

const project = document.getElementById("fcmProjectId");
if (project && document.activeElement !== project) {
  project.value = c.alerts?.fcmProjectIdOverride || "";
  project.placeholder = c.alerts?.fcmProjectIdSource === "service-account"
    ? "Auto: " + c.alerts.fcmProjectId
    : "Optional Firebase project ID override";
}
const status = document.getElementById("fcmStatus");
if (status) {
  const projectStatus = !c.alerts?.fcmProjectId
    ? "project ID missing"
    : c.alerts?.fcmProjectIdSource === "override"
      ? "project ID ✓ (override)"
      : "project ID ✓ (service account)";
  const serviceAccountStatus = c.alerts?.fcmServiceAccountValid
    ? "service account ✓"
    : c.alerts?.fcmServiceAccountPresent
      ? "service account invalid"
      : "service account missing";
  const parts = [
    projectStatus,
    serviceAccountStatus,
    c.alerts?.fcmTokenRegistered ? "phone token ✓" : "phone token missing",
  ];
  status.textContent = parts.join(" · ");
}
renderAlertTransportFields();
  const alertOnly = c.mode === "alert-only";
  const whitelistHeading = [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Auto-send whitelist");
  if (whitelistHeading) {
    whitelistHeading.style.display = alertOnly ? "none" : "";
    if (whitelistHeading.nextElementSibling) whitelistHeading.nextElementSibling.style.display = alertOnly ? "none" : "";
  }
  const alarmHeading = [...document.querySelectorAll("h2")].find((h) => ["Escalations", "Alarms"].includes(h.textContent.trim()));
  if (alarmHeading) alarmHeading.textContent = alertOnly ? "Alarms" : "Escalations";
}
async function refreshTunnelStatus() {
  try { renderTunnelStatus(await tunnelApi("/api/tunnel/status")); } catch { /* transient */ }
}
async function refreshRuntimeConfig() {
  try { applyRuntimeConfig(await tunnelApi("/api/runtime/config")); } catch { /* transient */ }
}
async function refreshRuntimeStatus() {
  await Promise.all([refreshTunnelStatus(), refreshRuntimeConfig()]);
}
function renderAlertTransportFields() {
  const fcm = document.getElementById("alertTransport")?.value === "fcm";
  const fields = document.getElementById("fcmFields");
  if (fields) fields.style.display = fcm ? "block" : "none";
}
async function saveAlertTransport() {
  const transport = document.getElementById("alertTransport").value;
  const projectId = document.getElementById("fcmProjectId").value.trim();
  try {
    const result = await tunnelApi("/api/config/alerts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport, projectId }),
    });
    applyRuntimeConfig(result);
    toast(transport === "fcm" ? "FCM selected" : "WebSocket selected");
  } catch (e) { toast(e.message); }
}
async function savePollInterval() {
  const seconds = Number(document.getElementById("pollIntervalSec").value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) {
    toast("Polling interval must be 1–300 seconds");
    return;
  }
  try {
    const result = await tunnelApi("/api/config/poll-interval", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollIntervalMs: Math.round(seconds * 1000) }),
    });
    document.getElementById("pollIntervalSec").value = String(result.pollIntervalMs / 1000);
    toast("Polling interval saved");
  } catch (e) { toast(e.message); }
}
async function startCloudflareTunnel() {
  try {
    await tunnelApi("/api/tunnel/start", { method:"POST" });
    toast("Cloudflare tunnel starting…");
  } catch (e) { toast(e.message); }
  setTimeout(refreshRuntimeStatus, 1200);
}
async function stopCloudflareTunnel() {
  const remote = location.hostname === "gui.guymichaely.com";
  if (remote && !confirm("Stop the Cloudflare tunnel? This page will disconnect, and you cannot restart the tunnel from this remote URL until it is reachable again locally.")) return;
  try {
    const r = await tunnelApi("/api/tunnel/stop", { method:"POST" });
    toast(r.killed ? "Cloudflare tunnel stopped" : "Tunnel is not running");
  } catch (e) {
    toast(remote ? "Tunnel stop sent; remote connection may now be offline" : e.message);
  }
  setTimeout(refreshRuntimeStatus, 1200);
}
refreshRuntimeStatus();
setInterval(refreshRuntimeStatus, 5000);
</script>`;

function injectTunnelControls(page) {
  if (page.includes('id="btnTunnelStart"')) return page;
  const oldHeader = `  <div class="row" style="justify-content:space-between">
    <div class="row">
      <span id="statusDot" class="dot" style="background:var(--dim)"></span>
      <h1>Teams Automation</h1>
      <span id="statusText" style="color:var(--dim)">…</span>
    </div>
    <div class="row">
      <button id="btnStart" onclick="startOrch()" disabled>Start</button>
      <button id="btnStop" class="danger" onclick="stopOrch()" disabled>Stop</button>
    </div>
  </div>`;
  const titleOnly = `  <div class="row"><h1>Teams Automation</h1></div>`;
  return page
    .replace(oldHeader, titleOnly)
    .replace("  <h2>Overview</h2>", TUNNEL_HTML + "\n  <h2>Overview</h2>")
    .replace("</body>", TUNNEL_SCRIPT + "\n</body>");
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
          return sendJson(res, 200, { ok: true, ...(await registerFcmToken(req)) });
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

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const coreEnd = res.end.bind(res);
      res.end = (chunk, encoding, callback) => {
        let body = chunk;
        if (typeof chunk === "string") body = injectTunnelControls(chunk);
        else if (Buffer.isBuffer(chunk)) body = Buffer.from(injectTunnelControls(chunk.toString("utf8")));
        return coreEnd(body, encoding, callback);
      };
    }
    return coreHandler(req, res);
  });

  return result;
}