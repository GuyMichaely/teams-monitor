// Thin runtime-control layer around the dashboard server.
// The dashboard implementation lives in gui-server-core.mjs; this module adds
// local start/stop/status controls for the already-provisioned `teams-gui`
// Cloudflare tunnel. It does not create tunnels, edit DNS, or call Cloudflare APIs.

import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGui as startCoreGui } from "./gui-server-core.mjs";
import { DATA_DIR } from "./state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  <h2>Cloudflare tunnel</h2>
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div class="row">
        <span id="tunnelDot" class="dot" style="background:var(--dim)"></span>
        <strong>teams-gui</strong>
        <span id="tunnelText" style="color:var(--dim)">checking…</span>
      </div>
      <div class="row">
        <button id="btnTunnelStart" onclick="startCloudflareTunnel()" disabled>Start tunnel</button>
        <button id="btnTunnelStop" class="danger" onclick="stopCloudflareTunnel()" disabled>Stop tunnel</button>
      </div>
    </div>
    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">
      Existing tunnel only: gui.guymichaely.com → this GUI. Stopping it remotely disconnects this page and the phone app.
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
async function refreshTunnelStatus() {
  try { renderTunnelStatus(await tunnelApi("/api/tunnel/status")); } catch { /* transient */ }
}
async function startCloudflareTunnel() {
  try {
    await tunnelApi("/api/tunnel/start", { method:"POST" });
    toast("Cloudflare tunnel starting…");
  } catch (e) { toast(e.message); }
  setTimeout(refreshTunnelStatus, 1200);
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
  setTimeout(refreshTunnelStatus, 1200);
}
refreshTunnelStatus();
setInterval(refreshTunnelStatus, 5000);
</script>`;

function injectTunnelControls(page) {
  if (page.includes('id="btnTunnelStart"')) return page;
  return page
    .replace("  <h2>Auto-send whitelist</h2>", TUNNEL_HTML + "\n  <h2>Auto-send whitelist</h2>")
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
    if (url.pathname.startsWith("/api/tunnel/")) {
      try {
        if (token && !authOk(req.headers.authorization, token)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
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