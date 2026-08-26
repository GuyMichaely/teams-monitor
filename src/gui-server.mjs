// Diagnostics layer around the runtime GUI/tunnel server.
// Logs connection behavior without logging GUI_TOKEN/access_token values.

import { join } from "node:path";
import { DATA_DIR } from "./state.mjs";
import { startGui as startRuntimeGui } from "./gui-server-runtime.mjs";
import { authOk, logDiagnostic, requestMeta, tailLines, tokenMatches } from "./gui-diagnostics.mjs";

const TUNNEL_LOG = join(DATA_DIR, "tunnel.log");
const TUNNEL_OUT_LOG = join(DATA_DIR, "tunnel.out.log");

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function diagnostics(limit) {
  const events = tailLines(join(DATA_DIR, "gui-diagnostics.jsonl"), limit).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
  return {
    generatedAt: new Date().toISOString(),
    serverPid: process.pid,
    events,
    tunnelLog: tailLines(TUNNEL_LOG, limit),
    tunnelOutLog: tailLines(TUNNEL_OUT_LOG, limit),
  };
}

const DIAGNOSTICS_HTML = `
  <h2>Connection diagnostics</h2>
  <div class="card">
    <div class="row" style="margin-bottom:8px">
      <button class="secondary" onclick="refreshDiagnostics()">Refresh</button>
      <button class="secondary" onclick="copyDiagnostics()">Copy diagnostics</button>
    </div>
    <pre id="diagnosticsLog">(no diagnostics loaded)</pre>
    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">
      Retry the phone connection, then copy this block. Auth-token values are never logged.
    </p>
  </div>
`;

const DIAGNOSTICS_SCRIPT = `<script>
let latestDiagnostics = "";
async function refreshDiagnostics() {
  try {
    const d = await tunnelApi("/api/diagnostics?limit=120");
    latestDiagnostics = JSON.stringify(d, null, 2);
    const pre = document.getElementById("diagnosticsLog");
    if (pre) { pre.textContent = latestDiagnostics; pre.scrollTop = pre.scrollHeight; }
  } catch (e) { toast(e.message); }
}
async function copyDiagnostics() {
  if (!latestDiagnostics) await refreshDiagnostics();
  try {
    await navigator.clipboard.writeText(latestDiagnostics);
    toast("Diagnostics copied");
  } catch { toast("Clipboard unavailable — select the diagnostics text manually"); }
}
refreshDiagnostics();
</script>`;

function injectDiagnostics(page) {
  if (page.includes('id="diagnosticsLog"')) return page;
  return page
    .replace("  <h2>Auto-send whitelist</h2>", DIAGNOSTICS_HTML + "\n  <h2>Auto-send whitelist</h2>")
    .replace("</body>", DIAGNOSTICS_SCRIPT + "\n</body>");
}

export function startGui(config) {
  const result = startRuntimeGui(config);
  const { server } = result;
  const runtimeHandler = server.listeners("request")[0];
  server.removeListener("request", runtimeHandler);
  const g = config?.gui || {};
  const token = process.env[g.authTokenEnv || "GUI_TOKEN"] || null;

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

    if (url.pathname === "/api/diagnostics") {
      if (token && !authOk(req.headers.authorization, token)) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 120, 1), 500);
      return sendJson(res, 200, diagnostics(limit));
    }

    if (url.pathname === "/api/alerts" || url.pathname === "/api/tunnel/start" || url.pathname === "/api/tunnel/stop") {
      const meta = requestMeta(req);
      const startedAt = Date.now();
      res.once("finish", () => {
        logDiagnostic(url.pathname === "/api/alerts" ? "alert_http" : "tunnel_control_http", {
          ...meta,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const runtimeEnd = res.end.bind(res);
      res.end = (chunk, encoding, callback) => {
        let body = chunk;
        if (typeof chunk === "string") body = injectDiagnostics(chunk);
        else if (Buffer.isBuffer(chunk)) body = Buffer.from(injectDiagnostics(chunk.toString("utf8")));
        return runtimeEnd(body, encoding, callback);
      };
    }

    return runtimeHandler(req, res);
  });

  return result;
}
