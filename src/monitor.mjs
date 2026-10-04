// Phase 1 — monitor engine.
// Enumerate chats, find which are unread (via Teams' own "Unread" filter), and
// read the recent messages of a given chat. All over a single CDP session.
//
// The Unread filter is switched on and LEFT on for the whole monitor session —
// Teams isn't used for anything else while the monitor runs, so there's no
// restore-on-exit (and none on a crash either).
//
// Opening a chat can mark it read, but is not reliable for an already-open chat.
// The orchestrator explicitly acknowledges after durable capture.

import {
  getChatSession,
  listChats,
  setUnreadFilter,
  openChat,
  readOpenChat,
  evalOnPage,
} from "./teams.mjs";
import { unreadChatsOnSession, markReadOnSession } from './teams-read-state.mjs';

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
    return await unreadChatsOnSession(session);
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
 * Opening may mark read, but does not guarantee it. markChatRead verifies it.
 */
export async function readChat(name, limit = 20, port) {
  const session = await getChatSession(port);
  let restoreFilter = null;
  try {
    let opened = await openChat(session, name, { exact: true });
    if (!opened) {
      // A reaction-only revisit may target a chat that no longer appears as unread.
      const r = await setUnreadFilter(session, false);
      if (r.ok) restoreFilter = r.wasOn;
      await settle(500);
      opened = await openChat(session, name, { exact: true });
      if (!opened) {
        await setUnreadFilter(session, true);
        await settle(500);
        opened = await openChat(session, name, { exact: true });
      }
    }
    if (!opened) throw new Error(`Chat not found in rail: "${name}"`);
    // Wait until the message pane reflects the newly opened chat.
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      const ready = await evalOnPage(
        session,
        `!!document.querySelector('[data-tid="message-pane-list-viewport"]') && (document.querySelector('[data-tid="chat-title"]')?.innerText || '').replace(/\\s+/g,' ').trim().toLowerCase() === ${JSON.stringify(name.replace(/\s+/g, ' ').trim().toLowerCase())}`
      );
      if (ready) { confirmed = true; break; }
      await settle(300);
    }
    if (!confirmed) throw new Error('Exact chat header could not be verified');
    // A chat can reopen at its saved scroll position, above the newest messages.
    const moved = await evalOnPage(session, `(() => {
      const pane = document.querySelector('[data-tid="message-pane-list-viewport"]');
      if (pane.scrollHeight - pane.clientHeight - pane.scrollTop < 4) return false;
      pane.scrollTop = pane.scrollHeight; return true;
    })()`);
    if (moved) await settle(300);
    const messages = await readOpenChat(session, limit);
    return { chat: name, messages };
  } finally {
    // Restore the rail filter if we changed it, so we don't leave the user's UI filtered.
    if (restoreFilter !== null) {
      try { await setUnreadFilter(session, restoreFilter); } catch { /* ignore */ }
    }
    session.close();
  }
}

/** Acknowledge only the unchanged, durably captured tail of the exact open chat. */
export async function markChatRead(name, receipt, port, guard) {
  const session = await getChatSession(port);
  try { return await markReadOnSession(session, name, receipt, guard); }
  finally { session.close(); }
}
