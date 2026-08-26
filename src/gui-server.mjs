// Monitoring/management GUI — a single-page dashboard + JSON API served from
// this machine. Zero-dependency (node:http), same style as the TFS dispatcher.
//
// Run:   node src/cli.mjs gui
//
// Auth:  OPTIONAL. If the env var named by config.gui.authTokenEnv (default
//        GUI_TOKEN) is set, every /api/* request must send it as
//        Authorization: Bearer <token> and the page prompts for it once.
//        If the env var is NOT set the GUI runs open — do that only behind
//        an authenticating layer (e.g. Cloudflare Access on the tunnel).
//
// Exposure: binds 127.0.0.1 by default (config.gui.host). Publish it through
// an outbound tunnel (e.g. `cloudflared tunnel`) — do NOT port-forward the raw
// port. The built-in token is defense-in-depth behind whatever auth the tunnel
// layer (e.g. Cloudflare Access) adds.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, STATE_FILE, ACTIVITY_LOG } from "./state.mjs";
import { hardStop } from "./orchestrator.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "config", "config.json");
const STOP_FILE = join(DATA_DIR, "STOP");
const HEARTBEAT_FILE = join(DATA_DIR, "heartbeat.json");
const ORCH_LOG = join(DATA_DIR, "orchestrator.log");
const APK_FILE = join(ROOT, "android-app", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const PROFILE_FILE = join(ROOT, "context", "user-profile.md");

// ---- small helpers --------------------------------------------------------

const sendJson = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

function authOk(header, token) {
  const m = /^Bearer\s+(.+)$/.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, cap = 1_048_576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { reject(Object.assign(new Error("payload too large"), { httpCode: 400 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Read at most the last `maxBytes` of a file and return its lines. */
async function tailLines(path, maxBytes = 262_144) {
  if (!existsSync(path)) return [];
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop partial first line
    return text.split("\n").filter(Boolean);
  } finally {
    await fh.close();
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readHeartbeat() {
  if (!existsSync(HEARTBEAT_FILE)) return null;
  try { return JSON.parse(await readFile(HEARTBEAT_FILE, "utf8")); } catch { return null; }
}

/** Liveness from the heartbeat the orchestrator writes every tick. */
async function orchestratorStatus(pollIntervalMs) {
  const hb = await readHeartbeat();
  if (!hb) return { running: false, pid: null, lastTickAt: null, ageMs: null };
  const ageMs = Date.now() - Date.parse(hb.at || 0);
  const fresh = ageMs < Math.max(2 * (pollIntervalMs || 15000), 45_000);
  const alive = pidAlive(hb.pid);
  return {
    running: alive && fresh,
    stale: alive && !fresh, // process exists but the loop stopped ticking
    pid: hb.pid || null,
    lastTickAt: hb.at || null,
    ageMs,
  };
}

function startOrchestrator() {
  const out = openSync(ORCH_LOG, "a");
  const child = spawn(process.execPath, [join(ROOT, "src", "cli.mjs"), "run"], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: ROOT,
  });
  child.unref();
  return child.pid;
}

// ---- API ------------------------------------------------------------------

async function apiOverview(config) {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  const orchestrator = await orchestratorStatus(cfg.pollIntervalMs);
  // Rough 24h counters from the activity tail.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const lines = await tailLines(ACTIVITY_LOG);
  let escalations = 0, sends = 0, decisions = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (Date.parse(r.at) < cutoff) continue;
      if (r.kind === "escalation") escalations++;
      else if (r.kind === "send") sends++;
      else if (r.kind === "decision") decisions++;
    } catch { /* skip bad line */ }
  }
  return {
    orchestrator,
    stopRequested: existsSync(STOP_FILE),
    config: {
      provider: cfg.brain?.provider || "?",
      model: cfg.brain?.model || "",
      pollIntervalMs: cfg.pollIntervalMs,
      whitelist: cfg.whitelist?.autoSend || [],
      holdMessage: cfg.holdMessage || "",
      echoLoop: !!cfg.debug?.echoLoop,
      tfsEnabled: !!cfg.integrations?.tfs?.enabled,
    },
    counts24h: { escalations, sends, decisions },
    guiVersion: 1,
  };
}

async function apiActivity(limit) {
  const lines = await tailLines(ACTIVITY_LOG);
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return parsed.slice(-limit).reverse();
}

async function apiWhitelistPut(body) {
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw Object.assign(new Error("invalid JSON"), { httpCode: 400 }); }
  const list = parsed?.autoSend;
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s.length)) {
    throw Object.assign(new Error("autoSend must be an array of non-empty strings"), { httpCode: 400 });
  }
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.whitelist = { ...(cfg.whitelist || {}), autoSend: [...new Set(list)] };
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  return { ok: true, autoSend: cfg.whitelist.autoSend };
}

// ---- alert websocket hub ----------------------------------------------------
//
// Companion apps (and any test client) subscribe on /ws/alerts; POST /api/alerts
// broadcasts to every connected socket. Hand-rolled RFC6455, zero-dependency —
// we only ever SEND text frames, so the parser just handles ping/close.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const alertClients = new Set();

/** Unmasked server->client frame. opcode 0x1 = text, 0x8 = close, 0xA = pong. */
function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcastAlert(obj) {
  const frame = wsFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));
  for (const sock of alertClients) {
    try {
      sock.write(frame);
    } catch {
      alertClients.delete(sock);
    }
  }
  return alertClients.size;
}

/** Consume client frames (masked per spec): reply to pings, honor closes. */
function wsOnData(sock, buf) {
  for (;;) {
    if (buf.length < 2) return buf;
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const masked = buf[1] & 0x80;
    const maskOff = off;
    if (masked) off += 4;
    if (buf.length < off + len) return buf;
    let payload = buf.subarray(off, off + len);
    if (masked) {
      const mask = buf.subarray(maskOff, maskOff + 4);
      payload = Buffer.from(payload); // copy before mutating
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    if (opcode === 0x8) {
      try { sock.write(wsFrame(0x8)); } catch { /* ignore */ }
      sock.destroy();
    } else if (opcode === 0x9) {
      try { sock.write(wsFrame(0xA, payload)); } catch { /* ignore */ }
    }
    buf = buf.subarray(off + len);
  }
}

function handleUpgrade(req, socket, token) {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws/alerts") return socket.destroy();
  // Browsers/clients can't set headers on WebSocket handshakes, so the token
  // rides as ?access_token=. Timing-safe compare, same as the HTTP API.
  if (token) {
    const given = url.searchParams.get("access_token") || "";
    const ok =
      given.length === token.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  alertClients.add(socket);
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    try {
      buf = wsOnData(socket, Buffer.concat([buf, d]));
    } catch {
      socket.destroy();
    }
  });
  const drop = () => alertClients.delete(socket);
  socket.on("close", drop);
  socket.on("error", drop);
}

// ---- server ---------------------------------------------------------------

export function startGui(config) {
  const g = config?.gui || {};
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"] || null;
  const port = g.port || 8090;
  const host = g.host || "127.0.0.1";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }

      // Latest companion-app build, straight from the Gradle output dir — every
      // rebuild is immediately downloadable. Deliberately NOT token-gated: the
      // APK holds no secrets (the token is entered in the app's Settings), and
      // a phone browser can just open the URL.
      if (req.method === "GET" && url.pathname === "/app-debug.apk") {
        try {
          const apk = await readFile(APK_FILE);
          res.writeHead(200, {
            "Content-Type": "application/vnd.android.package-archive",
            "Content-Disposition": 'attachment; filename="teams-monitor-debug.apk"',
            "Content-Length": apk.length,
          });
          return res.end(apk);
        } catch {
          return sendJson(res, 404, { ok: false, error: "APK not built yet" });
        }
      }

      if (!url.pathname.startsWith("/api/")) {
        return sendJson(res, 404, { ok: false, error: "not found" });
      }
      if (token && !authOk(req.headers.authorization, token)) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }

      if (req.method === "GET" && url.pathname === "/api/overview") {
        return sendJson(res, 200, await apiOverview(config));
      }
      if (req.method === "GET" && url.pathname === "/api/activity") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
        return sendJson(res, 200, await apiActivity(limit));
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        if (!existsSync(STATE_FILE)) return sendJson(res, 200, { chats: {} });
        return sendJson(res, 200, JSON.parse(await readFile(STATE_FILE, "utf8")));
      }
      if (req.method === "GET" && url.pathname === "/api/log") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
        const lines = await tailLines(ORCH_LOG);
        return sendJson(res, 200, { lines: lines.slice(-limit) });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        // Break glass: kill the orchestrator process now (STOP file is dropped
        // too, as a fallback for a loop that hasn't heartbeated yet).
        const result = hardStop();
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
        const status = await orchestratorStatus(cfg.pollIntervalMs);
        if (status.running || status.stale) {
          return sendJson(res, 409, { ok: false, error: `already running (pid ${status.pid})` });
        }
        if (existsSync(STOP_FILE)) rmSync(STOP_FILE); // don't let a stale stop kill the new run
        const pid = startOrchestrator();
        return sendJson(res, 200, { ok: true, pid });
      }
      if (req.method === "POST" && url.pathname === "/api/alerts") {
        // Alert ingress (from the orchestrator's alert_phone action): broadcast
        // to companion apps subscribed on /ws/alerts.
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { ok: false, error: "invalid JSON" });
        }
        const delivered = broadcastAlert({ kind: "alert", ...payload, at: new Date().toISOString() });
        return sendJson(res, 200, { ok: true, delivered });
      }
      if (req.method === "PUT" && url.pathname === "/api/whitelist") {
        return sendJson(res, 200, await apiWhitelistPut(await readBody(req)));
      }
      // The brain's user context (context/user-profile.md), editable live —
      // the orchestrator re-reads it every tick.
      if (req.method === "GET" && url.pathname === "/api/profile") {
        const text = existsSync(PROFILE_FILE) ? await readFile(PROFILE_FILE, "utf8") : "";
        return sendJson(res, 200, { text });
      }
      if (req.method === "PUT" && url.pathname === "/api/profile") {
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { ok: false, error: "invalid JSON" });
        }
        if (typeof parsed?.text !== "string") {
          return sendJson(res, 400, { ok: false, error: "text must be a string" });
        }
        await writeFile(PROFILE_FILE, parsed.text);
        return sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(parsed.text) });
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      sendJson(res, e.httpCode || 500, { ok: false, error: e.message });
    }
  });

  server.on("upgrade", (req, socket) => handleUpgrade(req, socket, token));

  server.listen(port, host, () =>
    console.error(
      `▶  GUI listening on http://${host}:${port}  ` +
        (token ? `(token auth via env ${g.authTokenEnv || "GUI_TOKEN"})`
               : `(OPEN — no ${g.authTokenEnv || "GUI_TOKEN"} set; gate it at the tunnel layer)`)
    )
  );
  return { server, close: () => new Promise((r) => server.close(r)) };
}

// ---- the page -------------------------------------------------------------

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Teams Automation</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#262b36; --fg:#d7dae0; --dim:#8b93a1;
          --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#4c8dff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.45 system-ui, "Segoe UI", sans-serif; }
  main { max-width:900px; margin:0 auto; padding:16px; }
  h1 { font-size:17px; margin:0; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:22px 0 8px; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .kv .k { color:var(--dim); font-size:12px; }
  .kv .v { font-size:16px; margin-top:2px; word-break:break-word; }
  .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px;
           padding:7px 14px; font-size:13px; cursor:pointer; }
  button.secondary { background:#2a3040; }
  button.danger { background:var(--bad); }
  button:disabled { opacity:.45; cursor:default; }
  input[type=text] { background:#0c0e12; color:var(--fg); border:1px solid var(--line);
           border-radius:8px; padding:7px 10px; font-size:13px; min-width:220px; }
  .chip { display:inline-flex; align-items:center; gap:6px; background:#222735;
          border:1px solid var(--line); border-radius:999px; padding:3px 6px 3px 12px; margin:3px 4px 3px 0; }
  .chip b { font-weight:500; }
  .chip button { background:none; color:var(--dim); padding:0 6px; font-size:15px; }
  .feed { display:flex; flex-direction:column; gap:8px; }
  .item { border-left:3px solid var(--line); padding:6px 10px; background:var(--card);
          border-radius:0 8px 8px 0; }
  .item.escalation { border-left-color:var(--bad); }
  .item.send { border-left-color:var(--ok); }
  .item .meta { color:var(--dim); font-size:12px; }
  .item .body { margin-top:2px; white-space:pre-wrap; word-break:break-word; }
  pre { background:#0c0e12; border:1px solid var(--line); border-radius:8px; padding:10px;
        overflow:auto; max-height:320px; font-size:12px; }
  #login { position:fixed; inset:0; background:rgba(10,12,16,.92); display:flex;
           align-items:center; justify-content:center; }
  #login .card { width:min(360px, 90vw); }
  .hidden { display:none !important; }
  .toast { position:fixed; bottom:14px; left:50%; transform:translateX(-50%);
           background:#222735; border:1px solid var(--line); padding:8px 16px;
           border-radius:8px; opacity:0; transition:opacity .2s; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<div id="login" class="hidden"><div class="card">
  <h1>Dashboard token</h1>
  <p style="color:var(--dim)">Paste the GUI token to connect.</p>
  <div class="row"><input id="tokenInput" type="text" placeholder="token">
  <button onclick="saveToken()">Connect</button></div>
</div></div>

<main>
  <div class="row" style="justify-content:space-between">
    <div class="row">
      <span id="statusDot" class="dot" style="background:var(--dim)"></span>
      <h1>Teams Automation</h1>
      <span id="statusText" style="color:var(--dim)">…</span>
    </div>
    <div class="row">
      <button id="btnStart" onclick="startOrch()" disabled>Start</button>
      <button id="btnStop" class="danger" onclick="stopOrch()" disabled>Stop</button>
    </div>
  </div>

  <h2>Overview</h2>
  <div class="grid" id="cards"></div>

  <h2>Auto-send whitelist</h2>
  <div class="card">
    <div id="chips"></div>
    <div class="row" style="margin-top:8px">
      <input id="wlInput" type="text" placeholder="Exact chat display name">
      <button class="secondary" onclick="addChip()">Add</button>
      <button id="wlSave" onclick="saveWhitelist()" disabled>Save</button>
    </div>
    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">
      Empty = nothing ever auto-sends; every chat holds + escalates. Changes apply within one poll tick.
    </p>
  </div>

  <h2>Brain context (user-profile.md)</h2>
  <div class="card">
    <textarea id="profile" rows="14" spellcheck="false"
      oninput="profDirty=true;document.getElementById('profSave').disabled=false"
      style="width:100%;box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:13px/1.4 monospace;resize:vertical"></textarea>
    <div class="row" style="margin-top:8px">
      <button id="profSave" onclick="saveProfile()" disabled>Save</button>
    </div>
    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">
      Everything here is sent to the model with every decision — keep it focused.
      The orchestrator re-reads it each tick, so saving applies within seconds.
    </p>
  </div>

  <h2>Escalations</h2>
  <div class="feed" id="escalations"><span style="color:var(--dim)">none yet</span></div>

  <h2>Recent activity</h2>
  <div class="feed" id="activity"><span style="color:var(--dim)">none yet</span></div>

  <h2>Orchestrator log</h2>
  <pre id="log">(empty)</pre>
</main>
<div class="toast" id="toast"></div>

<script>
let token = localStorage.guiToken || "";
let wl = [], wlDirty = false, profDirty = false;

function showLogin() { document.getElementById("login").classList.remove("hidden"); }
function saveToken() {
  token = document.getElementById("tokenInput").value.trim();
  localStorage.guiToken = token;
  document.getElementById("login").classList.add("hidden");
  refresh(true);
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts,
    headers: { ...(token ? { "Authorization": "Bearer " + token } : {}), ...(opts.headers || {}) } });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ago = (iso) => {
  if (!iso) return "?";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s/60) + "m ago";
  if (s < 86400) return Math.round(s/3600) + "h ago";
  return Math.round(s/86400) + "d ago";
};

function renderOverview(o) {
  const st = o.orchestrator;
  const dot = document.getElementById("statusDot");
  const txt = document.getElementById("statusText");
  if (st.running) { dot.style.background = "var(--ok)"; txt.textContent = "running · tick " + ago(st.lastTickAt); }
  else if (st.stale) { dot.style.background = "var(--warn)"; txt.textContent = "stale — pid " + st.pid + " alive but not ticking"; }
  else { dot.style.background = "var(--bad)"; txt.textContent = "stopped"; }
  if (o.stopRequested) txt.textContent += " · stop requested";
  document.getElementById("btnStart").disabled = st.running || st.stale;
  document.getElementById("btnStop").disabled = !(st.running || st.stale);

  const c = o.config, n = o.counts24h;
  document.getElementById("cards").innerHTML = [
    ["Brain", esc(c.provider + (c.model ? " · " + c.model : ""))],
    ["Poll", (c.pollIntervalMs/1000) + "s" + (c.echoLoop ? " · echoLoop!" : "")],
    ["Whitelisted chats", c.whitelist.length],
    ["Escalations 24h", n.escalations],
    ["Auto-sends 24h", n.sends],
    ["Decisions 24h", n.decisions],
  ].map(([k,v]) => '<div class="card kv"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join("");

  if (!wlDirty) { wl = [...c.whitelist]; renderChips(); }
}
function renderChips() {
  document.getElementById("chips").innerHTML = wl.length
    ? wl.map((name,i) => '<span class="chip"><b>'+esc(name)+'</b><button onclick="rmChip('+i+')">×</button></span>').join("")
    : '<span style="color:var(--dim)">empty — fully silent mode</span>';
  document.getElementById("wlSave").disabled = !wlDirty;
}
function addChip() {
  const v = document.getElementById("wlInput").value.trim();
  if (!v || wl.includes(v)) return;
  wl.push(v); wlDirty = true; document.getElementById("wlInput").value = ""; renderChips();
}
function rmChip(i) { wl.splice(i,1); wlDirty = true; renderChips(); }
async function saveWhitelist() {
  await api("/api/whitelist", { method:"PUT", body: JSON.stringify({ autoSend: wl }),
    headers: {"Content-Type":"application/json"} });
  wlDirty = false; renderChips(); toast("Whitelist saved");
}

async function loadProfile() {
  const p = await api("/api/profile");
  document.getElementById("profile").value = p.text;
}
async function saveProfile() {
  await api("/api/profile", { method:"PUT", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ text: document.getElementById("profile").value }) });
  profDirty = false;
  document.getElementById("profSave").disabled = true;
  toast("Brain context saved — applies within one tick");
}

function renderActivity(items) {
  const escFeed = document.getElementById("escalations");
  const actFeed = document.getElementById("activity");
  const escItems = items.filter(r => r.kind === "escalation").slice(0, 20);
  escFeed.innerHTML = escItems.length ? escItems.map(r =>
    '<div class="item escalation"><div class="meta">'+esc(r.payload?.chat)+' · '+ago(r.at)+'</div>' +
    '<div class="body">'+esc(r.payload?.latest?.author ?? "?")+': '+esc(r.payload?.latest?.text ?? "")+'</div>' +
    '<div class="meta">'+esc(r.payload?.reason ?? "")+'</div></div>').join("")
    : '<span style="color:var(--dim)">none yet</span>';
  actFeed.innerHTML = items.length ? items.slice(0, 40).map(r => {
    if (r.kind === "decision") return '<div class="item"><div class="meta">'+esc(r.chat)+' · '+ago(r.at)+' · <b>'+esc(r.action)+'</b></div><div class="body">'+esc(r.reason ?? "")+'</div></div>';
    if (r.kind === "send") return '<div class="item send"><div class="meta">'+esc(r.chat)+' · '+ago(r.at)+' · sent'+(r.hold ? " (hold msg)" : "")+'</div><div class="body">'+esc(r.text ?? "")+'</div></div>';
    if (r.kind === "escalation") return '<div class="item escalation"><div class="meta">'+esc(r.payload?.chat)+' · '+ago(r.at)+' · escalation</div></div>';
    return '<div class="item"><div class="meta">'+esc(r.kind)+' · '+ago(r.at)+'</div><div class="body">'+esc(JSON.stringify(r).slice(0,200))+'</div></div>';
  }).join("") : '<span style="color:var(--dim)">none yet</span>';
}

async function startOrch() { try { await api("/api/start", {method:"POST"}); toast("Orchestrator starting…"); } catch(e){ toast(e.message);} setTimeout(refresh, 1500); }
async function stopOrch()  { try { const r = await api("/api/stop",  {method:"POST"}); toast(r.killed ? "Orchestrator killed" : "Stop requested (" + (r.reason || "not running") + ")"); } catch(e){ toast(e.message);} setTimeout(refresh, 1500); }

async function refresh(first) {
  // No pre-check for a token: if the server runs open, everything just works;
  // if it wants auth, the first 401 pops the login prompt.
  try {
    renderOverview(await api("/api/overview"));
    renderActivity(await api("/api/activity?limit=100"));
    if (first && !profDirty) await loadProfile();
    const log = await api("/api/log?limit=200");
    const pre = document.getElementById("log");
    pre.textContent = log.lines.length ? log.lines.join("\\n") : "(empty)";
    if (first) pre.scrollTop = pre.scrollHeight;
  } catch (e) { /* login shown on 401; transient errors just skip a cycle */ }
}
refresh(true);
setInterval(refresh, 5000);
</script>
</body>
</html>`;
