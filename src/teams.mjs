// Core library: automate Microsoft Teams (new WebView2 client) over the Chrome DevTools Protocol.
//
// If Teams isn't running with a remote debugging port, getChatSession() restarts it
// automatically: kills any existing instance, then launches via the app execution
// alias with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS scoped to that process.

import { spawn } from "node:child_process";
import { join } from "node:path";

const DEFAULT_PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a CDP websocket to a specific target and return a small send() helper. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      const timer = setTimeout(() => { pending.delete(msgId); reject(new Error('Teams CDP command timed out')); }, 1500);
      pending.set(msgId, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id: msgId, method, params })); }
      catch (error) { clearTimeout(timer); pending.delete(msgId); reject(error); }
    });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Teams CDP connection timed out')); ws.close(); }, 1000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Teams CDP connection failed')); }, { once: true });
  });
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Teams CDP closed')); } pending.clear(); });
  return { send, ready, close: () => ws.close() };
}

const isTeamsPage = (t) => t.type === "page" && t.url.includes("teams.microsoft.com");

/** Fetch the CDP target list, or null if the debug port isn't reachable. */
async function listTargets(port) {
  try {
    const r = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Run a command, resolving with stdout. Never rejects — a missing process is fine. */
function sh(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.on("error", () => resolve(""));
  });
}

/** Force-quit Teams (all instances) and wait until the processes are gone. */
async function killTeams() {
  await sh("taskkill", ["/F", "/IM", "ms-teams.exe"]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const out = await sh("tasklist", ["/FI", "IMAGENAME eq ms-teams.exe", "/NH"]);
    if (!/ms-teams\.exe/i.test(out)) return;
    await sleep(500);
  }
}

/**
 * Launch Teams with the debug port, detached, via its app execution alias.
 * The alias is a reparse point that fs.existsSync can't see, so launch failure
 * is reported via the spawn 'error' event instead.
 */
function launchTeams(port) {
  const alias = join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "ms-teams.exe");
  spawn(alias, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  })
    .on("error", (e) => console.error(`Failed to launch Teams via ${alias}: ${e.message}`))
    .unref();
}

/**
 * Make sure Teams is running with the CDP debug port exposed. If it isn't —
 * not running, or running without the debug flag — restart it (killing the
 * existing instance if necessary) and wait for the app window to come up.
 */
export async function ensureTeams(port = DEFAULT_PORT) {
  if (process.env.TEAMS_MONITOR_DEV === '1') throw new Error('Development never restarts Teams; supply a mock CDP server.');
  if ((await listTargets(port))?.some(isTeamsPage)) return;
  if (process.platform !== "win32") {
    throw new Error("Teams auto-relaunch is only implemented on Windows.");
  }

  console.error("⏳ Teams is not running with the debug port — restarting it...");
  await killTeams();
  launchTeams(port);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if ((await listTargets(port))?.some(isTeamsPage)) {
      console.error("✔  Teams is up with the debug port.");
      return;
    }
  }
  throw new Error(`Teams did not come up on debug port ${port} within 2 minutes.`);
}

/**
 * Find the main Teams app window (has the chat rail or an open chat), connect to
 * it, and return the session. Restarts Teams with the debug port if it isn't
 * reachable. readOpenChat/sendMessage still need a chat to be open — readChat()
 * opens one itself.
 */
export async function getChatSession(port = DEFAULT_PORT) {
  if (process.env.TEAMS_MONITOR_DEV === '1' && port !== 29222) throw new Error('Development requires mock CDP port 29222.');
  if (!(await listTargets(port))?.some(isTeamsPage)) {
    await ensureTeams(port);
  }
  // Find the main app window. After a (re)launch the UI takes a while to render
  // the rail, so poll rather than failing on the first empty check.
  const deadline = Date.now() + 5000;
  for (;;) {
    const pages = ((await listTargets(port)) || []).filter(isTeamsPage);
    for (const p of pages) {
      let c;
      try {
        c = connect(p.webSocketDebuggerUrl);
        await c.ready;
        await c.send("Runtime.enable");
        const r = await c.send("Runtime.evaluate", {
          expression: `!!(document.querySelector('[data-tid="ckeditor"]') || document.querySelector('[role="treeitem"]'))`,
          returnByValue: true,
        });
        if (r?.result?.value === true) return c;
        c.close();
      } catch {
        c?.close();
        // Page mid-reload — skip it this round.
      }
    }
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  throw new Error("No Teams app window was found (no chat rail, no open chat).");
}

export async function evalOnPage(session, expression) {
  const r = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || "in-page evaluation failed");
  }
  return r.result.value;
}

/**
 * List every chat/channel row visible in the left rail, in order.
 * Returns [{ name, index }]. Names are the reliable identifier (row ids are
 * session-generated and not stable).
 */
export async function listChats(session) {
  return await evalOnPage(
    session,
    `(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')];
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        // A real chat/channel row is a leaf (no nested treeitems) with a last-message
        // timestamp. This cleanly excludes section headers (Favorites/Chats/Teams),
        // quick views (Mentions/Discover/Drafts) and actions (See more/Join communities).
        if (r.querySelector('[role="treeitem"]')) continue; // has children -> section header
        if (!r.querySelector('time')) continue; // no timestamp -> not a chat
        const name = (r.innerText || '').split('\\n')[0].replace(/\\s+/g, ' ').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, index: out.length });
      }
      return out;
    })()`
  );
}

/**
 * Toggle the rail's "Unread" quick filter to `on`, returning the previous state
 * so the caller can restore it. Uses Teams' own first-class filter rather than
 * brittle per-row unread styling.
 */
export async function setUnreadFilter(session, on) {
  return await evalOnPage(
    session,
    `(() => {
      const btn = [...document.querySelectorAll('button,[role="button"]')]
        .find(b => /^unread/i.test(b.getAttribute('aria-label') || ''));
      if (!btn) return { ok: false, reason: 'no-unread-button' };
      const wasOn = btn.getAttribute('aria-pressed') === 'true';
      if (wasOn !== ${Boolean(on)}) btn.click();
      return { ok: true, wasOn };
    })()`
  );
}

/**
 * Open a chat by its display name (clicks the matching rail row).
 * Returns true if a row was found and clicked. Matches exact name first,
 * then a case-insensitive startsWith fallback. exact:true requires one exact leaf row.
 */
export async function openChat(session, name, { exact = false } = {}) {
  return await evalOnPage(
    session,
    `(() => {
      const target = ${JSON.stringify(name)}.toLowerCase();
      const rows = [...document.querySelectorAll('[role="treeitem"]')];
      const rowName = (r) => (r.innerText || '').split('\\n')[0].replace(/\\s+/g, ' ').trim();
      const matches = rows.filter(r => rowName(r).toLowerCase() === target && !r.querySelector('[role="treeitem"]'));
      if (${exact} && matches.length !== 1) return false;
      let row = matches[0] || (${!exact} && rows.find(r => rowName(r).toLowerCase().startsWith(target)));
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      const clickable = row.querySelector('[role="button"], a, [tabindex]') || row;
      clickable.click();
      return true;
    })()`
  );
}

/** Read message metadata from the page's DOM (also serialized into the CDP page). */
export function readOpenChatFromDocument(doc, limit = 15) {
  const nodes = [...doc.querySelectorAll('[data-tid="chat-pane-message"]')];
  const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 15;
  return (count ? nodes.slice(-count) : []).map((n) => {
    const author = n.querySelector('[data-tid="message-author-name"]')?.innerText?.trim() || null;
    const time = n.querySelector('time')?.getAttribute('datetime') || null;
    const id = n.getAttribute('data-mid') || null;
    const reactions = [...n.querySelectorAll('[data-tid="diverse-reaction-pill-button"]')].flatMap(el => {
      const emoji = el.querySelector('[itemtype="http://schema.skype.com/Emoji"]');
      const label = (el.innerText || '').trim();
      const count = Number(label.match(/^(\d+)\s/)?.[1]);
      const key = emoji?.getAttribute('itemid');
      if (!key || !Number.isInteger(count) || count < 1) return [];
      return [{ key, emoji: emoji.getAttribute('alt') || key, count, self: el.getAttribute('aria-pressed') === 'true' }];
    });
    // Teams uses this schema.org-style marker for a real mention. Plain text,
    // including names prefixed with @, is deliberately not interpreted as one.
    const mentions = [...n.querySelectorAll('[itemtype="http://schema.skype.com/Mention"]')]
      .map((el) => (el.innerText || '').trim().replace(/^@\s*/, ''))
      .filter(Boolean);
    const clone = n.cloneNode(true);
    clone.querySelectorAll('[data-tid="message-author-name"], time, [data-tid="diverse-reaction-summary"]').forEach((el) => el.remove());
    const text = (clone.innerText || '').trim();
    return { id, author, time, text, mentions, reactions };
  });
}

/**
 * Read the most recent messages from the currently-open chat.
 * Returns [{ author, time (ISO), text, mentions }]. Mentions contains display
 * names found on Teams' explicit mention nodes; plain body text is not inferred.
 */
export async function readOpenChat(session, limit = 15) {
  const reader = readOpenChatFromDocument.toString();
  return await evalOnPage(session, `(${reader})(document, ${JSON.stringify(limit)})`);
}

export async function readMessages(limit = 15, port = DEFAULT_PORT) {
  const session = await getChatSession(port);
  try {
    return await readOpenChat(session, limit);
  } finally {
    session.close();
  }
}

/**
 * Send a message into the currently-open chat.
 * Returns "sent" on success, or a reason string ("no-compose-box", "send-disabled", ...).
 */
export async function sendMessage(text, port = DEFAULT_PORT) {
  const session = await getChatSession(port);
  try {
    return await evalOnPage(
      session,
      `(async () => {
        const box = document.querySelector('[data-tid="ckeditor"]');
        if (!box) return "no-compose-box";
        box.focus();
        document.execCommand('insertText', false, ${JSON.stringify(text)});
        await new Promise((r) => setTimeout(r, 150));
        const btn = document.querySelector('[data-tid="sendMessageCommands-send"]');
        if (!btn) return "no-send-button";
        if (btn.getAttribute('aria-disabled') === 'true' || btn.disabled) return "send-disabled";
        btn.click();
        return "sent";
      })()`
    );
  } finally {
    session.close();
  }
}

/**
 * Poll the open chat and invoke onMessage(msg) for each newly-arrived message.
 * De-dups against the previous poll (we read the tail each tick, so overlap
 * between polls is expected). Returns a stop() function.
 */
export function watchMessages(onMessage, { intervalMs = 3000, port = DEFAULT_PORT } = {}) {
  const key = (m) => `${m.time}|${m.author}|${m.text}`;
  let prev = null; // keys from the last poll; null until the first (seeding) poll
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const msgs = await readMessages(30, port);
      if (prev) {
        for (const m of msgs) {
          if (!prev.has(key(m))) onMessage(m);
        }
      }
      prev = new Set(msgs.map(key)); // first poll just seeds, so we only fire on new messages
    } catch {
      // Transient (chat switched, Teams busy); keep polling.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
