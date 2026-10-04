import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { markReadOnSession, unreadChatsOnSession, readReceipt } from '../src/teams-read-state.mjs';
import { teamsOperation } from '../src/teams-broker.mjs';

function fixture({ unread = true, retained = false, hidden = false, update = true, ambiguous = false, wrongMenu = false, beforeEval = () => {} } = {}) {
  const messages = [{ id: '1', author: 'Alex', time: '2026-10-04T00:00:00Z', text: 'hello', mentions: [], reactions: [] }];
  const state = { unread, retained, hidden, filtered: true, menu: wrongMenu ? 'other' : null, clicks: 0, composer: 'unsent draft', header: 'Alex', top: 100, messages, filters: [] };
  const row = { id: 'row-1', innerText: 'Alex', querySelector: selector => selector === 'time' ? {} : null,
    getAttribute: attr => attr === 'aria-labelledby' ? `${state.unread ? 'chat_list_unread_text ' : ''}chat-title` : null,
    dispatchEvent: event => { assert.equal(event.type, 'contextmenu'); state.menu = 'row-1'; } };
  const command = { getAttribute: () => null, click() { state.clicks++; if (update) state.unread = false; state.menu = null; } };
  const menu = { getAttribute: () => state.menu,
    querySelector: selector => selector.includes(state.unread ? 'change-read-status-menu-item' : 'change-unread-status-menu-item') ? command : null,
    dispatchEvent: event => { assert.equal(event.key, 'Escape'); state.menu = null; } };
  const button = { getAttribute: attr => attr === 'aria-label' ? 'Unread (Ctrl+Alt+U)' : String(state.filtered),
    click() { state.filtered = !state.filtered; state.filters.push(state.filtered); state.retained = false; state.hidden = false; state.menu = null; } };
  const document = {
    getElementById: id => id === 'chat_list_unread_text' ? { textContent: 'Unread message' } : null,
    querySelector(selector) {
      if (selector.includes('chat-title')) return { innerText: state.header };
      if (selector.includes('message-pane-list-viewport')) return { scrollHeight: 200, clientHeight: 100, scrollTop: state.top };
      throw Error('Unexpected selector ' + selector);
    },
    querySelectorAll(selector) {
      if (selector === '[role="treeitem"]') return !state.hidden && (!state.filtered || state.unread || state.retained) ? (ambiguous ? [row, row] : [row]) : [];
      if (selector === '[role="menu"]') return state.menu ? [menu] : [];
      if (selector === 'button,[role="button"]') return [button];
      if (selector === '[data-tid="chat-pane-message"]') return state.messages.map(message => ({
        getAttribute: () => message.id,
        querySelector: selector => selector.includes('message-author-name') ? { innerText: message.author } : selector === 'time' ? { getAttribute: () => message.time } : null,
        querySelectorAll: () => [],
        cloneNode: () => ({ innerText: message.text, querySelectorAll: () => [] }),
      }));
      throw Error('Unexpected selector ' + selector);
    },
  };
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const session = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate', 'Never send keyboard input or type into Teams');
    beforeEval(params.expression, state);
    const value = runInNewContext(params.expression, { document, KeyboardEvent: Event, MouseEvent: Event });
    return { result: { value: JSON.parse(JSON.stringify(value)) } };
  } };
  return { state, session, receipt: readReceipt(messages) };
}

{
  const f = fixture({ unread: false, retained: true });
  assert.deepEqual(await unreadChatsOnSession(f.session), []);
  assert.deepEqual(f.state.filters, [false, true], 'Reapply Teams filter to clear retained read row');
  assert.equal(f.state.clicks, 0, 'Enumerating unread must not acknowledge anything');
}
{
  const f = fixture({ hidden: true });
  assert.deepEqual(await unreadChatsOnSession(f.session), ['Alex'], 'Refresh even an empty cached list to find missing unread rows');
  assert.deepEqual(f.state.filters, [false, true]);
  assert.equal(f.state.clicks, 0);
}
{
  const f = fixture();
  assert.deepEqual(await unreadChatsOnSession(f.session), ['Alex']);
  let guard = 0;
  assert.deepEqual(await markReadOnSession(f.session, 'Alex', f.receipt, async () => { guard++; }), { verified: true, state: 'read', attempted: true });
  assert.equal(guard, 1); assert.equal(f.state.clicks, 1);
  assert.deepEqual(await unreadChatsOnSession(f.session), []);
  assert.equal(f.state.menu, null); assert.equal(f.state.filtered, true); assert.equal(f.state.composer, 'unsent draft');
}
{
  const f = fixture({ unread: false });
  assert.deepEqual(await markReadOnSession(f.session, 'Alex', f.receipt), { verified: true, state: 'read', attempted: false });
  assert.equal(f.state.clicks, 0, 'Never click Mark as unread');
}
for (const options of [{ ambiguous: true }, { wrongMenu: true }, { update: false }]) {
  const f = fixture(options);
  assert.equal((await markReadOnSession(f.session, 'Alex', f.receipt)).verified, false);
  assert.equal(f.state.clicks, options.update === false ? 1 : 0, 'No repeated mark-read attempts or wrong menu clicks');
}
for (const change of [state => { state.header = 'Someone else'; }, state => { state.top = 0; }, state => { state.messages[0].text = 'changed'; }]) {
  const f = fixture(); change(f.state);
  assert.equal((await markReadOnSession(f.session, 'Alex', f.receipt)).state, 'changed');
  assert.equal(f.state.clicks, 0);
}
{
  const f = fixture({ beforeEval(expression, state) {
    if (expression.includes(', "apply",')) state.messages.push({ ...state.messages[0], id: 'new', text: 'just arrived' });
  } });
  assert.equal((await markReadOnSession(f.session, 'Alex', f.receipt)).state, 'changed', 'Arrival between capture and click is not acknowledged');
  assert.equal(f.state.clicks, 0); assert.equal(f.state.menu, null);
}
{
  const f = fixture();
  await assert.rejects(markReadOnSession(f.session, 'Alex', f.receipt, async () => { throw Error('stopped'); }), /stopped/);
  assert.equal(f.state.clicks, 0); assert.equal(f.state.menu, null);
  const io = { config: async () => ({ port: 19222 }), markRead: async (chat, receipt, port, guard) => {
    assert.equal(chat, 'Alex'); assert.equal(port, 19222); await guard(); return markReadOnSession(f.session, chat, receipt);
  } };
  assert.equal((await teamsOperation({ operation: 'mark_read', chat: 'Alex', receipt: f.receipt }, io)).verified, true);
  await assert.rejects(teamsOperation({ operation: 'mark_read', chat: 'Alex', receipt: { count: 16, hash: f.receipt.hash } }, io));
  await assert.rejects(teamsOperation({ operation: 'mark_read', chat: 'Alex', receipt: f.receipt, owner: { pid: 1, runId: 'stale' } }, io), error => error.scheduleCode === 'stopped');
}
console.log('Teams unread checks passed: actual unread markers, retained-row refresh, exact-menu acknowledgement, verification, snapshot races, draft preservation and broker validation.');
