import { createHash } from 'node:crypto';
import { evalOnPage, setUnreadFilter, readOpenChat, readOpenChatFromDocument } from './teams.mjs';

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
export const readReceipt = messages => ({ count: messages.length, hash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') });

// Teams retains selected/read rows in its Unread view. The accessible unread
// marker, not membership in that view (nor bold styling), is authoritative.
export function unreadRailFromDocument(doc) {
  if (!doc.getElementById('chat_list_unread_text')) throw Error('Teams unread indicator unavailable');
  return [...doc.querySelectorAll('[role="treeitem"]')]
    .filter(row => !row.querySelector('[role="treeitem"]') && row.querySelector('time'))
    .map(row => ({ name: (row.innerText || '').split('\n')[0].replace(/\s+/g, ' ').trim(),
      unread: (row.getAttribute('aria-labelledby') || '').split(/\s+/).includes('chat_list_unread_text') }));
}

export async function unreadChatsOnSession(session) {
  // Teams can cache the filtered rail in either direction: a read row remains,
  // or an unread row appears only after reapplying the filter. Refresh every
  // snapshot, including empty lists; merely inspecting the DOM cannot fix it.
  const filter = await setUnreadFilter(session, false);
  if (!filter.ok) throw Error('Teams Unread filter unavailable');
  if (filter.wasOn) await settle(250);
  const enabled = await setUnreadFilter(session, true);
  if (!enabled.ok) throw Error('Teams Unread filter unavailable');
  await settle(500);
  const rows = await evalOnPage(session, `(${unreadRailFromDocument})(document)`);
  return [...new Set(rows.filter(row => row.unread && row.name).map(row => row.name))];
}

// Runs inside Teams. Menus are bound to their exact rail row through ARIA.
// Never click the inverse "Mark as unread" command or a different chat's menu.
export function readStateInDocument(doc, name, operation, expected, reader) {
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const rows = [...doc.querySelectorAll('[role="treeitem"]')].filter(row =>
    !row.querySelector('[role="treeitem"]') && row.querySelector('time') && normalize(row.innerText.split('\n')[0]) === normalize(name));
  if (rows.length !== 1) return { state: 'unconfirmed', reason: rows.length ? 'ambiguous-chat' : 'missing-row' };
  const row = rows[0];
  const menus = [...doc.querySelectorAll('[role="menu"]')];
  const menu = menus.find(menu => (menu.getAttribute('aria-labelledby') || '').split(/\s+/).includes(row.id));
  if (operation === 'dismiss') {
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    return { state: 'dismissed' };
  }
  const viewport = doc.querySelector('[data-tid="message-pane-list-viewport"]');
  const sameCapture = () => normalize(doc.querySelector('[data-tid="chat-title"]')?.innerText) === normalize(name)
    && viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 4
    && JSON.stringify(reader(doc, expected.count)) === expected.json;
  if (!sameCapture()) return { state: 'changed', reason: 'capture-changed' };
  if (operation === 'open') {
    if (menus.length && !menu) return { state: 'unconfirmed', reason: 'another-menu-open' };
    if (!menu) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    return { state: 'opening' };
  }
  if (!menu) return { state: 'unconfirmed', reason: 'missing-menu' };
  const markRead = menu.querySelector('[data-tid="change-read-status-menu-item"]');
  const markUnread = menu.querySelector('[data-tid="change-unread-status-menu-item"]');
  if (markUnread && !markRead) return { state: 'read' };
  if (!markRead || markUnread || markRead.getAttribute('aria-disabled') === 'true') return { state: 'unconfirmed', reason: 'missing-read-command' };
  if (operation === 'apply') {
    // Snapshot comparison and click share a JS turn: no intervening DOM update.
    markRead.click();
    return { state: 'unread', attempted: true };
  }
  return { state: 'unread' };
}

export async function markReadOnSession(session, name, receipt, guard = async () => {}) {
  let attempted = false;
  const result = (state, reason) => ({ verified: state === 'read', state, attempted, ...(reason ? { reason } : {}) });
  if (!Number.isInteger(receipt?.count) || receipt.count < 1 || receipt.count > 15 || !/^[a-f0-9]{64}$/.test(receipt.hash || '')) return result('unconfirmed', 'invalid-capture');
  const captured = await readOpenChat(session, receipt.count);
  if (readReceipt(captured).hash !== receipt.hash) return result('changed', 'capture-changed');
  const expected = { count: receipt.count, json: JSON.stringify(captured) };
  const run = operation => evalOnPage(session, `(${readStateInDocument})(document, ${JSON.stringify(name)}, ${JSON.stringify(operation)}, ${JSON.stringify(expected)}, ${readOpenChatFromDocument})`);
  let restore = null;
  try {
    let state = await run('open');
    if (state.reason === 'missing-row') {
      const filter = await setUnreadFilter(session, false);
      if (!filter.ok) return result('unconfirmed', 'missing-filter');
      restore = filter.wasOn;
      await settle(500);
      state = await run('open');
    }
    if (state.state !== 'opening') return result(state.state, state.reason);
    await settle(100);
    await guard();
    state = await run('apply');
    attempted = !!state.attempted;
    if (!attempted) return result(state.state, state.reason);
    // Wait for Teams' actual state change. A disappeared row counts only after
    // checking its read state in the unfiltered rail, not merely after clicking.
    await settle(250);
    for (let attempt = 0; attempt < 5; attempt++) {
      state = await run('open');
      if (state.reason === 'missing-row') {
        const filter = await setUnreadFilter(session, false);
        if (!filter.ok) return result('unconfirmed', 'missing-filter');
        if (restore === null) restore = filter.wasOn;
        await settle(250);
        state = await run('open');
      }
      if (state.state !== 'opening') return result(state.state, state.reason);
      await settle(100);
      state = await run('inspect');
      if (state.state !== 'unread') return result(state.state, state.reason);
      await run('dismiss');
      await settle(150);
    }
    return result('unread', 'read-not-confirmed');
  } finally {
    await run('dismiss').catch(() => {});
    if (restore !== null) {
      const filter = await setUnreadFilter(session, restore);
      if (!filter.ok) throw Error('Teams filter restoration failed');
      await settle(250);
    }
  }
}
