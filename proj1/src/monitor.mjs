// Phase 1 — monitor engine.
// Enumerate chats, find which are unread (via Teams' own "Unread" filter), and
// read the recent messages of a given chat. All over a single CDP session.
//
// The Unread filter is switched on and LEFT on for the whole monitor session —
// Teams isn't used for anything else while the monitor runs, so there's no
// restore-on-exit (and none on a crash either).
//
// SIDE EFFECT: opening a chat to read it marks it as read in your Teams. That is
// inherent to the GUI-hook approach. The orchestrator is meant to triage on your
// behalf, but be aware your own unread markers will move.

import {
  getChatSession,
  listChats,
  setUnreadFilter,
  openChat,
  readOpenChat,
  evalOnPage,
} from "./teams.mjs";

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

/**
 * Return the names of chats that currently have unread messages.
 * Ensures the rail's "Unread" filter is on (it stays on for the whole session —
 * see file header) and snapshots the filtered rail. Read-only w.r.t. message
 * content (does not open chats).
 */
export async function getUnreadChats(port) {
  const session = await getChatSession(port);
  try {
    const res = await setUnreadFilter(session, true);
    if (!res.ok) throw new Error(`Could not toggle Unread filter: ${res.reason}`);
    // Only wait for a re-render when we actually flipped the filter on.
    if (!res.wasOn) await settle();
    const chats = await listChats(session);
    return chats.map((c) => c.name);
  } finally {
    session.close();
  }
}

/** List every chat in the rail (unfiltered). */
export async function getAllChats(port) {
  const session = await getChatSession(port);
  try {
    return await listChats(session);
  } finally {
    session.close();
  }
}

/**
 * Open `name` and read its recent messages. Returns { chat, messages }.
 * NOTE: this marks the chat as read (see file header).
 */
export async function readChat(name, limit = 20, port) {
  const session = await getChatSession(port);
  let filterToggled = false;
  try {
    let opened = await openChat(session, name);
    if (!opened) {
      // Some chats (e.g. untitled meeting chats shown by numeric id) only appear
      // in the rail under the "Unread" filter, not the default view. Enable it and retry.
      const r = await setUnreadFilter(session, true);
      filterToggled = r.ok && !r.wasOn;
      await settle(500);
      opened = await openChat(session, name);
    }
    if (!opened) throw new Error(`Chat not found in rail: "${name}"`);
    // Wait until the message pane reflects the newly opened chat.
    for (let i = 0; i < 10; i++) {
      const ready = await evalOnPage(
        session,
        `!!document.querySelector('[data-tid="message-pane-list-viewport"]')`
      );
      if (ready) break;
      await settle(300);
    }
    const messages = await readOpenChat(session, limit);
    return { chat: name, messages };
  } finally {
    // Restore the rail filter if we changed it, so we don't leave the user's UI filtered.
    if (filterToggled) {
      try { await setUnreadFilter(session, false); } catch { /* ignore */ }
    }
    session.close();
  }
}
