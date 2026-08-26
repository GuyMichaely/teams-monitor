// Reference WORKER for TFS Agent Protocol v2 (pull model). Runs on the VM.
// Makes only OUTBOUND connections: long-polls the dispatcher for jobs, runs them
// against TFS, posts results back. Zero dependencies. Use, adapt, or replace.
//
// Env:
//   DISPATCHER_URL    (required) public URL of the dispatcher, e.g. https://you.example.com
//   TFS_AGENT_TOKEN   (required) shared bearer token (same as the dispatcher's)
//   TFS_WRITES_ENABLED ("false" to refuse writes locally)
//   plus TFS_* (see README) — the PAT lives here on the VM.

import { PRIMITIVES, dispatch } from "./handlers.mjs";
import { loadTfsConfig } from "./tfs.mjs";

const BASE = (process.env.DISPATCHER_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.TFS_AGENT_TOKEN;
const WRITES_ENABLED = process.env.TFS_WRITES_ENABLED !== "false";
const WAIT_S = 25;

if (!BASE || !TOKEN) {
  console.error("FATAL: set DISPATCHER_URL and TFS_AGENT_TOKEN.");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${TOKEN}` };
let tfsCfg = null;

async function pollOnce() {
  const res = await fetch(`${BASE}/jobs/next?wait=${WAIT_S}`, { headers: auth });
  if (res.status === 204) return null;
  if (res.status === 401) throw new Error("unauthorized (bad TFS_AGENT_TOKEN)");
  if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);
  return res.json(); // { id, method, params }
}

async function runJob(job) {
  let payload;
  try {
    if (!PRIMITIVES[job.method]) throw Object.assign(new Error(`unknown method: ${job.method}`), { code: "unknown_method" });
    if (!tfsCfg) tfsCfg = loadTfsConfig();
    const result = await dispatch(tfsCfg, job.method, job.params || {}, { allowWrites: WRITES_ENABLED });
    payload = { ok: true, result };
  } catch (e) {
    const code = e.code || (/read-only/.test(e.message) ? "write_disabled" : "tfs_error");
    payload = { ok: false, error: { code, message: e.message } };
  }
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(job.id)}/result`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ack = await res.json().catch(() => ({}));
  console.error(`job ${job.method} id=${job.id} -> ${payload.ok ? "ok" : "err"} (ack=${ack.ack})`);
}

console.error(`worker up. dispatcher=${BASE} writes=${WRITES_ENABLED}. polling…`);
let backoff = 1000;
for (;;) {
  try {
    const job = await pollOnce();
    backoff = 1000;
    if (job) await runJob(job);
  } catch (e) {
    console.error(`poll error: ${e.message}; retry in ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}
