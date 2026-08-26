// Dispatcher HTTP server (TFS Agent Protocol v2) — runs on THIS machine, published to
// the internet. The VM worker connects out to it. Also registers each TFS primitive as
// a brain-invocable action that enqueues a job and awaits the worker's result.
// Zero-dependency (node:http).

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { registerAction } from "../actions.mjs";
import { createQueue } from "./tfs-queue.mjs";

const PROTOCOL_VERSION = "2";

const TFS_METHODS = [
  "search_tickets", "list_states", "read_ticket", "read_ticket_comments",
  "list_attachments", "download_attachment", "change_state", "modify_ticket",
  "comment_ticket", "add_attachment", "assign_ticket", "link_tickets", "run_agent_task",
];
const WRITE_METHODS = new Set([
  "change_state", "modify_ticket", "comment_ticket", "add_attachment",
  "assign_ticket", "link_tickets", "run_agent_task",
]);

function authOk(header, token) {
  const m = /^Bearer\s+(.+)$/.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sendJson = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

function readBody(req, cap = 26_214_400) {
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

/**
 * Start the dispatcher and register TFS actions. Returns { queue, server, close }.
 * config.integrations.tfs: { serverPort, authTokenEnv, resultTimeoutMs, longPollMaxMs }
 */
export function startDispatcher(config) {
  const t = config?.integrations?.tfs || {};
  const token = process.env[t.authTokenEnv || "TFS_AGENT_TOKEN"];
  if (!token) {
    throw new Error(`TFS dispatcher needs a token: set env ${t.authTokenEnv || "TFS_AGENT_TOKEN"}`);
  }
  const port = t.serverPort || 8080;
  const longPollMaxMs = t.longPollMaxMs || 30000;
  const queue = createQueue({ resultTimeoutMs: t.resultTimeoutMs || 120000 });

  const server = createServer(async (req, res) => {
    try {
      if (!authOk(req.headers.authorization, token)) {
        return sendJson(res, 401, { ok: false, error: { code: "unauthorized", message: "bad token" } });
      }
      const url = new URL(req.url, "http://x");

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true, protocolVersion: PROTOCOL_VERSION, role: "dispatcher", ...queue.stats(),
        });
      }

      if (req.method === "GET" && url.pathname === "/jobs/next") {
        const wait = Math.min(Number(url.searchParams.get("wait")) * 1000 || 25000, longPollMaxMs);
        const job = await queue.takeNext(wait);
        if (!job) { res.writeHead(204); return res.end(); }
        return sendJson(res, 200, job);
      }

      const m = /^\/jobs\/([^/]+)\/result$/.exec(url.pathname);
      if (req.method === "POST" && m) {
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw); }
        catch { return sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "invalid JSON" } }); }
        const ack = queue.submitResult(decodeURIComponent(m[1]), payload);
        return sendJson(res, 200, ack);
      }

      return sendJson(res, 404, { ok: false, error: { code: "bad_request", message: "not found" } });
    } catch (e) {
      const status = e.httpCode || 500;
      sendJson(res, status, { ok: false, error: { code: status === 400 ? "bad_request" : "internal", message: e.message } });
    }
  });

  // Register the brain-facing actions (they run when the brain asks for them).
  for (const method of TFS_METHODS) {
    registerAction({
      name: method,
      description: `TFS: ${method} (dispatched to the VM worker).`,
      sideEffect: WRITE_METHODS.has(method),
      run: async (args) => queue.enqueue(method, args),
    });
  }

  server.listen(port, () => console.error(`   TFS dispatcher listening on :${port} (protocol v${PROTOCOL_VERSION})`));
  return { queue, server, close: () => new Promise((r) => server.close(r)) };
}

export { TFS_METHODS, WRITE_METHODS };
