import { loadConfig, saveConfig } from "./context.mjs";
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
import { processRunId } from './process-diagnostics.mjs';
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { logDiagnostic } from "./gui-diagnostics.mjs";
import { controlState } from "./alert-runtime.mjs";
import { open, readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, STATE_FILE, ACTIVITY_LOG } from "./state.mjs";
import { visibleActivity } from "./activity-view.mjs";
import { hardStop } from "./orchestrator.mjs";
import { DASHBOARD_PAGE } from "./dashboard-page.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { PROFILE_FILE } from "./local-paths.mjs";
import { replyPolicy } from "./reply-policy.mjs";
const STOP_FILE = join(DATA_DIR, "STOP");
const HEARTBEAT_FILE = join(DATA_DIR, "heartbeat.json");
const ORCH_LOG = join(DATA_DIR, "orchestrator.log");
const APK_RELEASE_URL = "https://github.com/GuyMichaely/teams-monitor/releases/download/android-latest/teams-monitor.apk";

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
    windowsHide: true,
    stdio: ["ignore", out, out],
    cwd: ROOT,
  });
  child.unref();
  return child.pid;
}

// ---- API ------------------------------------------------------------------

async function apiOverview(config) {
  const cfg = await loadConfig();
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
      replyPolicy: replyPolicy(cfg),
      holdMessage: cfg.holdMessage || "",
      echoLoop: !!cfg.debug?.echoLoop,
      tfsEnabled: !!cfg.integrations?.tfs?.enabled,
    },
    counts24h: { escalations, sends, decisions },
    guiVersion: 1,
  };
}

async function apiActivity(limit) {
  // Brain prompts/raw output make flow records substantially larger than the old
  // activity entries. Keep enough tail bytes for dozens of complete flows.
  const lines = await tailLines(ACTIVITY_LOG, 2_097_152);
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { parsed.push({ kind: "invalid_log", error: "Invalid log format" }); }
  }
  return visibleActivity(parsed).slice(-limit).reverse();
}

async function apiWhitelistPut(body) {
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw Object.assign(new Error("invalid JSON"), { httpCode: 400 }); }
  const list = parsed?.autoSend;
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s.length)) {
    throw Object.assign(new Error("autoSend must be an array of non-empty strings"), { httpCode: 400 });
  }
  const cfg = await loadConfig();
  cfg.whitelist = { ...(cfg.whitelist || {}), autoSend: [...new Set(list)] };
  cfg.replyPolicy = { mode: "whitelist", entries: cfg.whitelist.autoSend };
  await saveConfig(cfg);
  return { ok: true, autoSend: cfg.whitelist.autoSend };
}

// ---- alert websocket hub ----------------------------------------------------
//
// Companion apps (and any test client) subscribe on /ws/alerts; POST /api/alerts
// broadcasts to every connected socket. Hand-rolled RFC6455, zero-dependency —
// We send text and ping frames; clients return pong or close frames.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const alertClients = new Set();
const clientLifecycle = new WeakMap();
export const alertClientCount = () => alertClients.size;

function trackClient(socket, { pingIntervalMs = 30_000, pongTimeoutMs = 10_000 } = {}) {
  let pendingPing = null;
  let timeout = null;
  let policyTimeout = null;
  let dropped = false;
  const drop = (reason) => {
    if (dropped) return;
    dropped = true;
    clearInterval(interval);
    clearTimeout(timeout);
    clearTimeout(policyTimeout);
    alertClients.delete(socket);
    clientLifecycle.delete(socket);
    logDiagnostic('ws_connection_removed', { reason, remainingClients: alertClients.size });
    socket.destroy();
  };
  const interval = setInterval(() => {
    if (pendingPing) return;
    if (socket.destroyed || !socket.writable || socket.readableEnded) return drop('socket_ended');
    pendingPing = randomBytes(12);
    timeout = setTimeout(() => drop('pong_timeout'), pongTimeoutMs);
    timeout.unref?.();
    try { socket.write(wsFrame(0x9, pendingPing)); } catch { drop('ping_write_failed'); }
  }, pingIntervalMs);
  interval.unref?.();
  const pong = (payload) => {
    if (!pendingPing || !payload.equals(pendingPing)) return;
    pendingPing = null;
    clearTimeout(timeout);
    timeout = null;
  };
  const policy = (state) => {
    if (dropped) return;
    clearTimeout(policyTimeout);
    const actions = [`set_primary_${state.primaryTransport}`, state.websocketWanted ? 'start_ws' : 'stop_ws'];
    try { socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ kind: 'control', actions })))); }
    catch { return drop('policy_write_failed'); }
    logDiagnostic('ws_delivery_policy_sent', { primaryTransport: state.primaryTransport, websocketWanted: state.websocketWanted });
    if (!state.websocketWanted) {
      // Give the phone time to stop its service. A live but noncompliant socket
      // must not remain usable indefinitely merely because it answers pings.
      policyTimeout = setTimeout(async () => {
        try {
          const current = await controlState(await loadConfig());
          if (dropped) return;
          if (current.websocketWanted) return policy(current);
          drop('delivery_policy_disabled');
        } catch (error) {
          logDiagnostic('ws_policy_check_failed', { error: error.message });
        }
      }, 1000);
      policyTimeout.unref?.();
    }
  };
  alertClients.add(socket);
  clientLifecycle.set(socket, { drop, pong, policy });
  // Upgraded HTTP sockets can remain half-open after peer FIN; close is not enough.
  socket.once('end', () => drop('peer_end'));
  socket.once('close', () => drop('socket_closed'));
  socket.once('error', () => drop('socket_error'));
}

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
    if (sock.destroyed || !sock.writable || sock.readableEnded) {
      clientLifecycle.get(sock)?.drop('socket_ended');
      continue;
    }
    try {
      sock.write(frame);
    } catch {
      clientLifecycle.get(sock)?.drop('broadcast_write_failed');
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
    if (!masked || !Number.isSafeInteger(len) || len > 1_048_576 ||
        (opcode >= 8 && (len > 125 || !(buf[0] & 0x80)))) {
      clientLifecycle.get(sock)?.drop('invalid_frame');
      return Buffer.alloc(0);
    }
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
      clientLifecycle.get(sock)?.drop('peer_close');
      return Buffer.alloc(0);
    } else if (opcode === 0x9) {
      try { sock.write(wsFrame(0xA, payload)); } catch { /* ignore */ }
    } else if (opcode === 0xA) {
      clientLifecycle.get(sock)?.pong(payload);
    }
    buf = buf.subarray(off + len);
  }
}

function handleUpgrade(req, socket, token, options, head) {
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
  trackClient(socket, options);
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    try {
      buf = wsOnData(socket, Buffer.concat([buf, d]));
    } catch {
      clientLifecycle.get(socket)?.drop('frame_parse_error');
    }
  };
  socket.on("data", onData);
  if (head?.length) onData(head);
  // Catch reconnects and connection/setup races that missed a settings broadcast.
  controlStateFromDisk().then(state => clientLifecycle.get(socket)?.policy(state)).catch(error => {
    logDiagnostic('ws_policy_check_failed', { error: error.message });
  });
}

async function controlStateFromDisk() { return controlState(await loadConfig()); }

export function applyAlertDeliveryPolicy(state) {
  for (const socket of alertClients) clientLifecycle.get(socket)?.policy(state);
}

// ---- server ---------------------------------------------------------------

export function startGui(config, websocketOptions) {
  const g = config?.gui || {};
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"] || null;
  const port = g.port || 8090;
  const host = g.host || "127.0.0.1";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(DASHBOARD_PAGE);
      }

      // Public download alias; never forward request tokens or cache a release asset URL.
      if (["GET", "HEAD"].includes(req.method) && url.pathname === "/app-debug.apk") {
        res.writeHead(302, {
          Location: APK_RELEASE_URL,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        return res.end();
      }

      if (!url.pathname.startsWith("/api/")) {
        return sendJson(res, 404, { ok: false, error: "not found" });
      }
      if (token && !authOk(req.headers.authorization, token)) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }

      // Independent of CDP, disk/config reads and tunnel health.
      if (req.method === 'GET' && url.pathname === '/api/liveness') {
        res.setHeader('Cache-Control', 'no-store');
        return sendJson(res, 200, { ok: true, pid: process.pid, runId: processRunId });
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
        const cfg = await loadConfig();
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

  const ownedSockets = new Set();
  server.on("upgrade", (req, socket, head) => {
    ownedSockets.add(socket);
    socket.once('close', () => ownedSockets.delete(socket));
    handleUpgrade(req, socket, token, websocketOptions, head);
  });

  server.listen(port, host, () =>
    console.error(
      `▶  GUI listening on http://${host}:${port}  ` +
        (token ? `(token auth via env ${g.authTokenEnv || "GUI_TOKEN"})`
               : `(OPEN — no ${g.authTokenEnv || "GUI_TOKEN"} set; gate it at the tunnel layer)`)
    )
  );
  return { server, close: () => {
    for (const socket of ownedSockets) {
      clientLifecycle.get(socket)?.drop('server_shutdown');
      socket.destroy();
    }
    return new Promise((r) => server.close(r));
  } };
}

export function broadcastControl(actions) {
  return broadcastAlert({ kind: "control", actions });
}
