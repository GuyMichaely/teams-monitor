// Use the profile menu, never slash commands or keyboard focus (which can hit a chat).
import { evalOnPage } from "./teams.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROFILE = "me-control-avatar-trigger";
const MENU = "set-presence-status-menu-item";
const BADGE = "me-control-avatar-presence";
const PREFIX = "me_control_presence_availability_";
const STATUSES = {
  available: ["Available", "available"], busy: ["Busy", "busy"],
  dnd: ["Do not disturb", "do_not_disturb"], brb: ["Be right back", "be_right_back"],
  away: ["Appear away", "appear_away"], offline: ["Appear offline", "appear_offline"],
};
const compact = (v) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
export function normalizeStatus(value) {
  const key = Object.keys(STATUSES).find(k => [k, compact(STATUSES[k][0])].includes(compact(value)));
  if (!key) throw Object.assign(new Error("status must be available, busy, dnd, brb, away, or offline"), { httpCode: 400 });
  return key;
}

// Every target/command is bounded: Teams exposes background pages that may never respond.
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("Teams CDP connection timed out")); ws.close(); }, 800);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Teams CDP connection failed")); }, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error("Teams CDP command timed out")); }, 1200);
    pending.set(key, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: key, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(key); reject(e); }
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  ws.addEventListener("close", () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Teams CDP connection closed")); }
    pending.clear();
  });
  return { ready, send, close: () => ws.close() };
}

async function findSession(port) {
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    targets = await response.json();
  } catch { return null; }
  // Inspect in parallel so a stalled background page cannot block the actual window.
  const sessions = await Promise.all(targets.filter(t => {
    try { return t.type === "page" && ["teams.microsoft.com", "teams.cloud.microsoft"].includes(new URL(t.url).hostname); }
    catch { return false; }
  }).map(async t => {
    const session = connect(t.webSocketDebuggerUrl);
    try {
      await session.ready;
      const main = await evalOnPage(session, `!!document.querySelector('[data-tid="${PROFILE}"]')`);
      if (main) return session;
    } catch { /* Stale/reloading page; another target may be the main window. */ }
    session.close(); return null;
  }));
  const matches = sessions.filter(Boolean);
  if (matches.length === 1) return matches[0];
  for (const session of matches) session.close();
  if (matches.length > 1) throw Object.assign(new Error("Multiple Teams profile windows found; close extra Teams windows before changing status"), { httpCode: 409 });
  return null;
}

// Shared bounded discovery; scheduled sends must not restart Teams or choose an ambiguous window.
export async function getTeamsProfileSession(port = 9222) { return findSession(port); }

async function readPresence(session) {
  const raw = await evalOnPage(session, `document.querySelector('[data-tid="${BADGE}"]')?.getAttribute('aria-label') || null`);
  let value = null;
  try { value = normalizeStatus(raw); } catch { /* Preserve meeting/call/unknown labels verbatim. */ }
  return { connected: true, value, status: raw, raw };
}

async function visible(session, tid) {
  return evalOnPage(session, `!!document.querySelector('[data-tid="${tid}"]')?.getClientRects().length`);
}
async function waitVisible(session, tid) {
  for (let i = 0; i < 10; i++) { if (await visible(session, tid)) return; await sleep(100); }
  throw new Error(`Teams presence control did not appear: ${tid}`);
}
async function click(session, tid) {
  const clicked = await evalOnPage(session, `(() => {
    const el = document.querySelector('[data-tid="${tid}"]');
    if (!el?.getClientRects().length || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    el.click(); return true;
  })()`);
  if (!clicked) throw new Error(`Teams presence control unavailable: ${tid}`);
}

export async function setPresenceOnSession(session, requestedStatus, isCurrent = () => true) {
  const key = normalizeStatus(requestedStatus);
  const before = await readPresence(session);
  let openedProfile = false;
  try {
    if (!await visible(session, MENU)) { await click(session, PROFILE); openedProfile = true; }
    await waitVisible(session, MENU);
    const option = PREFIX + STATUSES[key][1];
    if (!await visible(session, option)) await click(session, MENU);
    await waitVisible(session, option);
    if (!isCurrent()) return { ok: false, superseded: true, requested: key };
    await click(session, option);
    // A successful click is not proof of a successful presence update.
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (!isCurrent()) return { ok: false, superseded: true, requested: key, attempted: true };
      const current = await readPresence(session);
      if (!isCurrent()) return { ok: false, superseded: true, requested: key, attempted: true, value: current.value, status: current.status };
      if (current.value === key) return { ...current, ok: true, verified: true, attempted: true, requested: key, previous: before.raw };
    }
    throw Object.assign(new Error(`Teams did not confirm ${STATUSES[key][0]}; read back the current status before retrying`), { httpCode: 502 });
  } finally {
    if (openedProfile) {
      // Only dismiss our own menu, never send Escape/Enter into the user's editor.
      await evalOnPage(session, `(() => { const el = document.querySelector('[data-tid="${PROFILE}"]'); if (el?.getAttribute('aria-expanded') === 'true') el.click(); })()`).catch(() => {});
    }
  }
}

export async function getTeamsPresence(port = 9222) {
  const session = await findSession(port);
  if (!session) return { connected: false, value: null, status: null, raw: null };
  try { return await readPresence(session); } finally { session.close(); }
}

const queues = new Map();
let requestId = 0;
const supersededResult = (request) => ({ ok: false, superseded: true, requested: request.status });

export async function setTeamsPresence(status, port = 9222, { expiresAt = Infinity } = {}) {
  const key = normalizeStatus(status); // Validate before connecting or touching Teams.
  if (Date.now() > expiresAt) return { ok: false, expired: true, requested: key };
  const queue = queues.get(port) ?? { latest: null, running: false };
  queues.set(port, queue);
  const request = { id: ++requestId, status: key, expiresAt };
  let resolve, reject;
  const result = new Promise((res, rej) => { resolve = res; reject = rej; });
  request.resolve = resolve; request.reject = reject;
  if (queue.latest) queue.latest.resolve(supersededResult(queue.latest));
  queue.latest = request;
  if (!queue.running) void drainPresenceQueue(port, queue);
  return result;
}

async function drainPresenceQueue(port, queue) {
  queue.running = true;
  try {
    while (queue.latest) {
      const request = queue.latest;
      let session;
      try {
        if (Date.now() > request.expiresAt) { request.resolve({ ok: false, expired: true, requested: request.status }); if (queue.latest === request) queue.latest = null; continue; }
        session = await findSession(port);
        if (!session) throw Object.assign(new Error("Teams profile is not reachable over CDP; open Teams with the debugging port enabled"), { httpCode: 503 });
        if (queue.latest !== request) { request.resolve(supersededResult(request)); continue; }
        const response = await setPresenceOnSession(session, request.status, () => queue.latest === request && Date.now() <= request.expiresAt);
        request.resolve(Date.now() > request.expiresAt ? { ok: false, expired: true, attempted: !!response.attempted, requested: request.status } : response);
      } catch (error) {
        if (queue.latest !== request) request.resolve(supersededResult(request));
        else request.reject(error);
      } finally { session?.close(); }
      if (queue.latest === request) queue.latest = null;
    }
  } finally {
    queue.running = false;
    if (queue.latest) void drainPresenceQueue(port, queue);
    else queues.delete(port);
  }
}
