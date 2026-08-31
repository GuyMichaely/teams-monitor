// Teams availability control over the existing WebView2 CDP connection.
// Setting a status uses Teams' own search-box slash commands rather than private APIs.

import { ensureTeams } from "./teams.mjs";

const DEFAULT_PORT = 9222;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATUSES = {
  available: { label: "Available", command: "/available" },
  busy: { label: "Busy", command: "/busy" },
  dnd: { label: "Do not disturb", command: "/dnd" },
  brb: { label: "Be right back", command: "/brb" },
  away: { label: "Away", command: "/away" },
  offline: { label: "Offline", command: "/offline" },
};

const REQUEST_ALIASES = new Map([
  ["available", "available"],
  ["busy", "busy"],
  ["dnd", "dnd"],
  ["donotdisturb", "dnd"],
  ["berightback", "brb"],
  ["brb", "brb"],
  ["away", "away"],
  ["appearaway", "away"],
  ["offline", "offline"],
  ["appearoffline", "offline"],
]);

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("Teams CDP websocket failed to open")), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  ws.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("Teams CDP websocket closed"));
    pending.clear();
  });
  return { ready, send, close: () => ws.close() };
}

function isTeamsPage(target) {
  return target.type === "page" && /teams\.(microsoft\.com|cloud\.microsoft)/i.test(target.url || "");
}

async function listTargets(port) {
  try {
    const response = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function evalOnPage(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Teams page evaluation failed");
  }
  return result.result.value;
}

async function findMainSession(port, { ensure = false, timeoutMs = 2500 } = {}) {
  let targets = await listTargets(port);
  if (!targets?.some(isTeamsPage) && ensure) {
    await ensureTeams(port);
    targets = await listTargets(port);
  }
  if (!targets?.some(isTeamsPage)) return null;

  const deadline = Date.now() + timeoutMs;
  do {
    for (const target of (targets || []).filter(isTeamsPage)) {
      const session = connect(target.webSocketDebuggerUrl);
      try {
        await session.ready;
        await session.send("Runtime.enable");
        const isMain = await evalOnPage(
          session,
          `!!(document.querySelector('[data-tid="me-control-avatar-presence"]') || document.querySelector('[data-tid="ckeditor"]') || document.querySelector('[role="treeitem"]'))`
        );
        if (isMain) return session;
      } catch {
        // The target may be reloading. Try the next page or the next pass.
      }
      session.close();
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
    targets = await listTargets(port);
  } while (targets?.some(isTeamsPage));
  return null;
}

function normalizeRequest(value) {
  const compact = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  const key = REQUEST_ALIASES.get(compact);
  if (!key) {
    throw Object.assign(new Error("status must be available, busy, dnd, brb, away, or offline"), { httpCode: 400 });
  }
  return key;
}

function normalizePresence(raw) {
  const compact = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!compact) return { value: null, status: null };
  if (compact.includes("donotdisturb")) return { value: "dnd", status: STATUSES.dnd.label };
  if (compact.includes("berightback")) return { value: "brb", status: STATUSES.brb.label };
  if (compact.includes("available")) return { value: "available", status: STATUSES.available.label };
  if (compact.includes("busy") || compact.includes("inameeting") || compact.includes("inacall")) {
    return { value: "busy", status: STATUSES.busy.label };
  }
  if (compact.includes("away")) return { value: "away", status: STATUSES.away.label };
  if (compact.includes("offline")) return { value: "offline", status: STATUSES.offline.label };
  return { value: null, status: String(raw).trim() || null };
}

async function readPresence(session) {
  const raw = await evalOnPage(
    session,
    `(() => {
      const badge = document.querySelector('[data-tid="me-control-avatar-presence"]')
        || document.querySelector('[data-tid*="avatar-presence"][aria-label]');
      return badge?.getAttribute('aria-label')?.trim() || null;
    })()`
  );
  return { raw, ...normalizePresence(raw) };
}

async function dispatchKey(session, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const common = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function ctrlShortcut(session, key, code, windowsVirtualKeyCode) {
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2,
  });
  await dispatchKey(session, key, code, windowsVirtualKeyCode, 2);
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 0,
  });
}

async function focusSearch(session) {
  await ctrlShortcut(session, "e", "KeyE", 69);
  await sleep(200);
  const focus = await evalOnPage(
    session,
    `(() => {
      const el = document.activeElement;
      if (!el) return { isSearch: false };
      const owner = el.closest?.('[data-tid]');
      const dataTid = el.getAttribute('data-tid') || owner?.getAttribute('data-tid') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const descriptor = [dataTid, ariaLabel, placeholder].join(' ').toLowerCase();
      const isComposer = el.matches?.('[data-tid="ckeditor"]') || !!el.closest?.('[data-tid="ckeditor"]');
      return {
        isSearch: !isComposer && descriptor.includes('search'),
        isComposer,
        tag: el.tagName,
        dataTid,
        ariaLabel,
        placeholder,
      };
    })()`
  );
  if (!focus?.isSearch) {
    throw Object.assign(
      new Error("Ctrl+E did not focus the Teams search box; refusing to type a status command"),
      { httpCode: 503 }
    );
  }
}

export async function getTeamsPresence(port = DEFAULT_PORT) {
  const session = await findMainSession(port, { ensure: false, timeoutMs: 2000 });
  if (!session) return { connected: false, status: null, value: null, raw: null };
  try {
    return { connected: true, ...(await readPresence(session)) };
  } finally {
    session.close();
  }
}

export async function setTeamsPresence(requestedStatus, port = DEFAULT_PORT) {
  const key = normalizeRequest(requestedStatus);
  const desired = STATUSES[key];
  const session = await findMainSession(port, { ensure: true, timeoutMs: 15_000 });
  if (!session) {
    throw Object.assign(new Error("Teams is running but its main WebView2 page was not found"), { httpCode: 503 });
  }

  try {
    await focusSearch(session);
    await ctrlShortcut(session, "a", "KeyA", 65);
    await dispatchKey(session, "Backspace", "Backspace", 8);
    await session.send("Input.insertText", { text: desired.command });
    await dispatchKey(session, "Enter", "Enter", 13);

    let current = await readPresence(session);
    for (let i = 0; i < 12 && current.value !== key; i++) {
      await sleep(250);
      current = await readPresence(session);
    }
    return {
      ok: true,
      requested: desired.label,
      command: desired.command,
      verified: current.value === key,
      connected: true,
      ...current,
    };
  } finally {
    session.close();
  }
}
