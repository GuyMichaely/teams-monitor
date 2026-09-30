import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { Database } from 'bun:sqlite';
import { DATA_DIR } from '../src/local-paths.mjs';
import { createScheduleStore, runScheduledAction, SCHEDULE_GRACE_MS, scheduleError } from '../src/scheduled-actions.mjs';
import { sendScheduledFromDocument, sendScheduledMessage, setScheduledPresence } from '../src/scheduled-teams.mjs';
import { openChat } from '../src/teams.mjs';
import { startGui } from '../src/gui-server.mjs';

let now = Date.parse('2026-10-01T12:00:00Z');
const file = join(DATA_DIR, 'schedule-tests.sqlite');
let store = createScheduleStore(file, () => now);
const due = seconds => new Date(now + seconds * 1000).toISOString();
const message = extra => ({ kind: 'message', chat: 'Alex', text: 'Scheduled message', dueAt: due(10), ...extra });
const status = extra => ({ kind: 'status', presence: 'away', dueAt: due(10), ...extra });
for (const body of [null, {}, message({ text: '' }), message({ chat: '' }), message({ dueAt: 'tomorrow' }), message({ dueAt: '2027-02-30T09:00:00Z' }), message({ dueAt: due(-1) }), status({ presence: 'nonsense' }), status({ dueAt: due(367 * 86400) }), status({ requestId: 'bad' })])
  assert.throws(() => store.create(body), { httpCode: 400 });
const requestId = randomUUID();
const first = store.create(message({ requestId }));
assert.equal(store.create(message({ requestId })).id, first.id, 'Ambiguous HTTP resubmission must not duplicate');
assert.throws(() => store.create(message({ requestId, text: 'different' })), { httpCode: 409 });
assert.equal(store.cancel(first.id).state, 'cancelled');
assert.equal(store.cancel(first.id).state, 'cancelled');
assert.throws(() => store.cancel(randomUUID()), { httpCode: 404 });
let cfg = { replyPolicy: { mode: 'whitelist', entries: ['Alex'] } }, sends = 0, changes = 0;
const io = {
  loadConfig: async () => cfg, now: () => now,
  sendMessage: async (chat, text, port, guard) => { await guard(); sends++; return 'sent'; },
  setPresence: async value => { changes++; return { verified: true, value }; },
};
const execute = extra => runScheduledAction({ store, ...io, ...extra });
let job = store.create(message());
assert.equal(await execute(), null, 'Not before due date');
now += 10000;
assert.equal((await execute()).state, 'completed'); assert.equal(sends, 1);
assert.equal(await execute(), null); assert.equal(sends, 1, 'At most once');
assert.throws(() => store.cancel(job.id), { httpCode: 409 });
job = store.create(message()); now += 10000;
cfg = { replyPolicy: { mode: 'whitelist', entries: [] } };
assert.equal((await execute()).state, 'blocked'); assert.equal(sends, 1);
cfg = { replyPolicy: { mode: 'blacklist', entries: [] } };
store.create(message()); now += 10000;
assert.equal((await execute({ sendMessage: async (chat, text, port, guard) => {
  cfg = { replyPolicy: { mode: 'blacklist', entries: ['Alex'] } }; await guard(); throw Error('Must not send');
} })).state, 'blocked', 'Policy changes during chat opening must win');
store.create(status()); now += 10000;
assert.equal((await execute()).state, 'completed'); assert.equal(changes, 1, 'Status unaffected by reply whitelist');
store.create(status()); now += 10000;
assert.equal((await execute({ setPresence: async () => ({ superseded: true }) })).state, 'superseded');
store.create(status()); now += 10000;
assert.equal((await execute({ setPresence: async () => ({ expired: true }) })).state, 'missed');
store.create(status()); now += 10000;
assert.equal((await execute({ setPresence: async () => ({ expired: true, attempted: true }) })).state, 'uncertain', 'Expiry after a click must not claim no action occurred');
store.create(message()); now += 10000; cfg = { replyPolicy: { mode: 'blacklist', entries: [] } };
assert.equal((await execute({ sendMessage: async () => { throw scheduleError('draft'); } })).state, 'failed');
store.create(message()); now += 10000;
assert.equal((await execute({ sendMessage: async () => { throw Error('connection lost after click'); } })).state, 'uncertain');
assert.equal(await execute(), null, 'Uncertain delivery must never retry');
store.create(message()); now += 10000;
assert.equal(await execute({ stopped: () => true }), null);
store.recover(new Date(now + 1).toISOString());
assert.equal(store.list()[0].state === 'pending', false, 'Missed while stopped');
const old = store.create(status()); now += SCHEDULE_GRACE_MS + 10001;
assert.equal(await execute(), null); assert.equal(store.list().find(x => x.id === old.id).state, 'missed');
const interrupted = store.create(message()); now += 10000;
assert.equal(store.claim().id, interrupted.id);
assert.throws(() => store.cancel(interrupted.id), { httpCode: 409 });
store.close(); store = createScheduleStore(file, () => now);
store.recover(new Date(now).toISOString());
assert.equal(store.list().find(x => x.id === interrupted.id).state, 'uncertain');
const future = store.create(status());
store.close(); store = createScheduleStore(file, () => now);
assert.equal(store.list().find(x => x.id === future.id).state, 'pending', 'Future schedule survives restart');
now += 10000;
const second = createScheduleStore(file, () => now);
const claimed = store.claim(); assert.equal(claimed.id, future.id);
assert.equal(second.claim(), null, 'Separate connections cannot claim the same job');
store.finish(claimed.id, claimed.attempt, 'completed'); second.close();
const malformed = store.create(message());
const corrupt = new Database(file);
corrupt.query('UPDATE schedules SET text=NULL WHERE id=?').run(malformed.id); corrupt.close();
now += 10000; assert.equal(store.claim(), null);
assert.equal(store.list().find(x => x.id === malformed.id).state, 'invalid', 'Corruption must fail closed');
store.close();

function dom({ chat = 'Alex', draft = '', duplicate = false, afterInsert = () => {}, disabled = false } = {}) {
  const state = { chat, text: draft, clicks: 0, filter: true, inserts: 0 };
  const box = { get innerText() { return state.text; }, focus() {}, getClientRects: () => [{}], querySelector: () => null };
  const button = { disabled, isConnected: true, getAttribute: () => null, click: () => state.clicks++ };
  const filter = { getAttribute: name => name === 'aria-label' ? 'Unread' : String(state.filter), click: () => state.filter = !state.filter };
  const rows = ['Alex', 'Alexander', ...(duplicate ? ['Alex'] : [])].map(name => ({ innerText: name, querySelector: () => null, scrollIntoView() {}, click() { state.chat = name; } }));
  const document = {
    querySelector(selector) {
      if (selector === '[data-tid="me-control-avatar-trigger"]') return {};
      if (selector === '[data-tid="chat-title"]') return { innerText: state.chat };
      if (selector === '[data-tid="ckeditor"]') return box;
      if (selector === '[data-tid="sendMessageCommands-send"]') return button;
      if (selector === '[role="treeitem"]') return rows[0];
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-tid="ckeditor"]') return [box];
      if (selector === '[role="treeitem"]') return rows;
      if (selector === 'button,[role="button"]') return [filter];
      return [];
    },
    execCommand(cmd, unused, text) { assert.equal(cmd, 'insertText'); state.inserts++; state.text = text; afterInsert(state); return true; },
  };
  return { state, document };
}
for (const [options, expected] of [[{}, 'sent'], [{ draft: 'my draft' }, 'draft'], [{ chat: 'Alexander' }, 'destination'], [{ afterInsert: s => s.chat = 'Someone else' }, 'unconfirmed'], [{ afterInsert: s => s.text += 'edited' }, 'unconfirmed'], [{ disabled: true }, 'unconfirmed']]) {
  const fixture = dom(options);
  assert.equal(await sendScheduledFromDocument(fixture.document, 'Alex', 'Message'), expected);
  assert.equal(fixture.state.clicks, expected === 'sent' ? 1 : 0);
  if (options.draft) assert.equal(fixture.state.text, options.draft);
}
for (const [name, duplicate, expected] of [['Alex', false, true], ['Al', false, false], ['Alex', true, false]]) {
  const fixture = dom({ duplicate });
  const session = { send: async (method, params) => ({ result: { value: runInNewContext(params.expression, { document: fixture.document }) } }) };
  assert.equal(await openChat(session, name, { exact: true }), expected, 'Exact unique recipient only');
}
const fixture = dom();
assert.equal(await sendScheduledFromDocument(fixture.document, 'Alex', 'Expired', Date.now() - 1), 'expired');
assert.equal(fixture.state.inserts, 0, 'Expired jobs must not type into Teams');
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch(req, server) {
    if (new URL(req.url).pathname.startsWith('/devtools/')) return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
    return Response.json([{ type: 'page', url: 'https://teams.microsoft.com/v2/', webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/live` }]);
  }, websocket: { async message(ws, raw) {
    const req = JSON.parse(raw);
    const value = req.method === 'Runtime.evaluate' ? await runInNewContext(req.params.expression, { document: fixture.document, setTimeout }) : undefined;
    ws.send(JSON.stringify({ id: req.id, result: { result: { value } } }));
  } },
});
try {
  assert.equal(await sendScheduledMessage('Alex', 'Via CDP', mock.port, async () => {}), 'sent');
  assert.equal(fixture.state.clicks, 1); assert.equal(fixture.state.filter, true);
  await assert.rejects(sendScheduledMessage('Al', 'Never send', mock.port, async () => {}), { scheduleCode: 'destination' });
  assert.equal(fixture.state.clicks, 1); assert.equal(fixture.state.filter, true);
} finally { mock.stop(true); }

process.env.SCHEDULE_TEST_TOKEN = 'schedule-fixture';
const gui = startGui({ gui: { host: '127.0.0.1', port: 18243, authTokenEnv: 'SCHEDULE_TEST_TOKEN' } }, {
  get: async () => ({ connected: true }),
  set: async (value, port, options) => ({ verified: true, value, expiresAt: options.expiresAt }),
});
if (!gui.server.listening) await new Promise(resolve => gui.server.once('listening', resolve));
const request = (path, method = 'GET', body, auth = true) => fetch('http://127.0.0.1:18243' + path, {
  method, headers: { 'Content-Type': 'application/json', Authorization: auth ? 'Bearer schedule-fixture' : '' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  for (const method of ['GET', 'POST']) assert.equal((await request('/api/schedules', method, undefined, false)).status, 401);
  assert.equal((await request('/api/schedules/' + randomUUID() + '/cancel', 'POST', undefined, false)).status, 401);
  assert.equal((await request('/api/schedules', 'POST', { kind: 'invalid' })).status, 400);
  const draft = { kind: 'message', chat: '<script>Alex</script>', text: '<b>not HTML</b>', dueAt: new Date(Date.now() + 3600000).toISOString(), requestId: randomUUID() };
  const created = await request('/api/schedules', 'POST', draft); assert.equal(created.status, 201);
  const job = await created.json(); assert.equal(job.state, 'pending');
  assert.equal((await (await request('/api/schedules', 'POST', draft)).json()).id, job.id);
  assert.equal((await (await request('/api/schedules')).json()).jobs.length, 1);
  assert.equal((await (await request('/api/schedules/' + job.id + '/cancel', 'POST')).json()).state, 'cancelled');
  assert.equal((await request('/api/schedules', 'DELETE')).status, 405);
  assert.equal((await request('/api/teams/presence', 'PUT', { status: 'busy', expiresAt: 'bad' })).status, 400);
  // The production adapter loads auth from config, never URL credentials.
  const old = process.env.GUI_TOKEN; process.env.GUI_TOKEN = 'schedule-fixture';
  assert.equal((await setScheduledPresence('away', { gui: { port: 18243 } }, Date.now() + 30000)).value, 'away');
  if (old === undefined) delete process.env.GUI_TOKEN; else process.env.GUI_TOKEN = old;
  const html = await (await request('/')).text();
  for (const marker of ['id="scheduleForm"', 'id="schedulePending"', 'id="scheduleHistory"']) assert(html.includes(marker));
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
} finally { await gui.close(); }
console.log('Scheduling: durable queue, idempotency, permissions, due times, cancellation, recovery/no replay, concurrent claims, corruption, safe recipient/draft handling, mock CDP and authenticated APIs passed.');
