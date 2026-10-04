import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { agentStore } from '../src/agent/store.mjs';
import { intake, messageContext } from '../src/agent/intake.mjs';
import { executeAction } from '../src/agent/executor.mjs';
import { executorLease, scan, runEngine } from '../src/agent/engine.mjs';
import { ownerActive } from '../src/agent/owner.mjs';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/local-paths.mjs';
const store = agentStore();
const now = Date.now(), activatedAt = new Date(now - 10000).toISOString();
const config = { alerts: { mentionNames: ['Me'] }, replyPolicy: { mode: 'whitelist', entries: ['Alice'] } };
const msg = (id, author, age, text = id) => ({ id, author, text, time: new Date(now - age).toISOString(), reactions: [] });
const messages = [msg('old', 'Alice', 20000), msg('a', 'Alice', 6000), msg('b', 'Alice', 5000), msg('self', 'Me', 4000), msg('c', 'Alice', 3000)];
const reactions = {};
assert.equal(intake({ store, chat: 'Alice', messages, config, activatedAt, reactions }).length, 3);
assert.equal(intake({ store, chat: 'Alice', messages, config, activatedAt, reactions }).length, 0);
assert.equal(store.history('Alice').length, 5);
for (const expected of ['a', 'b', 'c']) {
  const row = store.claimMessage(); assert.equal(row.value.id, expected);
  const ctx = messageContext(row, store, config, '');
  assert.equal(ctx.isDM, true);
  assert.equal(ctx.trigger, 'message');
  for (const legacy of ['latest', 'chat', 'ignoreAuthors', 'notifyAll', 'outcome', 'coverage']) assert.equal(Object.hasOwn(ctx, legacy), false);
  assert.equal(Object.hasOwn(ctx.message, 'reactions'), false, 'other authors\' badges are not automatically exposed');
  store.completeMessage(row.id, row.id, [{ id: expected, kind: 'message', chat: 'Alice', text: expected }], {});
}
assert.equal(store.claimMessage(), null);
const sent = [];
const io = { store, client: { send: async (chat, text) => { sent.push([chat, text]); return { result: 'sent' }; } }, loadConfig: async () => config };
assert.equal((await executeAction(io)).state, 'completed');
config.replyPolicy.entries = [];
assert.equal((await executeAction(io)).state, 'blocked');
config.replyPolicy.entries = ['Alice'];
io.client.send = async () => { throw Error('unconfirmed effect'); };
assert.equal((await executeAction(io)).state, 'uncertain');
assert.equal(await executeAction(io), null); assert.equal(sent.length, 1);
messages[1].reactions = [{ key: 'thumb', emoji: '👍', count: 1, self: false }];
assert.equal(intake({ store, chat: 'Alice', messages, config, activatedAt, reactions }).length, 0, 'reactions on someone else\'s message never queue automatic work');
messages[3].reactions = [{ key: 'thumb', emoji: '👍', count: 1, self: false }];
assert.equal(intake({ store, chat: 'Alice', messages, config, activatedAt, reactions }).length, 1);
assert.deepEqual(messageContext({ chat: 'Alice', value: messages[3] }, store, config, '').message.reactions,
  [{ emoji: '👍', count: 1, self: false }], 'policy badges omit the internal comparison key');
assert.equal(store.claimMessage().value.author, 'Unknown reactor');
const lease = await executorLease(0);
await lease();
const fixture = agentStore(':memory:');
let unreadCalls = 0, markReadAfterCapture = false;
await scan({ store: fixture, client: { unread: async () => ++unreadCalls === 1 ? ['Bob'] : [],
  read: async () => ({ messages: [msg('d', 'Bob', 1000), msg('e', 'Bob', 500)] }),
  markRead: async () => { markReadAfterCapture = fixture.history('Bob').length === 2; return { verified: true, state: 'read', attempted: true }; } },
  config, activatedAt, state: {}, audit: async () => {} });
assert.equal(fixture.claimMessage().value.id, 'd'); assert.equal(fixture.claimMessage().value.id, 'e');
assert.equal(markReadAfterCapture, true, 'read acknowledgement follows durable intake');
const { readPoll } = await import('../src/poll-status.mjs');
assert.equal((await readPoll()).unreadChats, 0, 'final unread snapshot reflects a chat cleared by marking read');
fixture.close(); store.close();
const reactionFixture = agentStore(':memory:');
const reactionState = { chats: { Alice: { reactionSnapshot: { activationId: activatedAt } } } };
let reactionPoll;
await scan({ store: reactionFixture, client: { unread: async () => [], read: async () => ({ messages: [] }),
  markRead: async () => ({ verified: true, state: 'read', attempted: false }) }, config, activatedAt, state: reactionState, audit: async () => {} });
reactionPoll = await readPoll();
assert.equal(reactionPoll.unreadChats, 0, 'reaction revisit does not count as unread');
assert.equal(reactionPoll.reactionChecks, 1);
reactionFixture.close();
const retainedFixture = agentStore(':memory:');
let readAudit;
await scan({ store: retainedFixture, client: { unread: async () => ['Carol'], read: async () => ({ messages: [msg('kept', 'Carol', 1000)] }),
  markRead: async () => { throw Error('ack lost'); } }, config, activatedAt, state: {}, audit: async entry => { if (entry.kind === 'poll_read_state') readAudit = entry; } });
assert.equal(retainedFixture.history('Carol')[0].value.text, 'kept', 'failed acknowledgement preserves captured intake');
assert.equal(readAudit.readResult.state, 'unconfirmed');
assert.equal((await readPoll()).errors, 1);
retainedFixture.close();
const partialFixture = agentStore(':memory:');
let partialAcknowledged = false;
await scan({ store: partialFixture, client: { unread: async () => ['Carol'],
  read: async () => ({ messages: [msg('retained', 'Carol', 1000), { ...msg('malformed', 'Carol', 1001), author: null }] }),
  markRead: async () => { partialAcknowledged = true; } }, config, activatedAt, state: {}, audit: async () => {} });
assert.equal(partialAcknowledged, false, 'Malformed records skipped by intake must not be acknowledged as captured');
assert.equal(partialFixture.history('Carol').length, 1);
assert.equal((await readPoll()).errors, 1);
partialFixture.close();
const unknownCountFixture = agentStore(':memory:');
let unknownCalls = 0;
await scan({ store: unknownCountFixture, client: { unread: async () => { if (++unknownCalls === 2) throw Error('refresh unavailable'); return []; },
  read: async () => ({ messages: [] }), markRead: async () => ({ verified: true, state: 'read', attempted: false }) },
  config, activatedAt, state: {}, audit: async () => {} });
assert.equal((await readPoll()).unreadChats, null, 'failed postread snapshot is unknown, not zero');
unknownCountFixture.close();
const echoFixture = agentStore(':memory:');
let echoReads = [];
await scan({ store: echoFixture, client: { unread: async () => { throw Error('Echo must use explicit targets'); }, read: async chat => { echoReads.push(chat); return { messages: [] }; },
  markRead: async () => ({ verified: true, state: 'read', attempted: false }) },
  config: { ...config, debug: { echoLoop: true } }, activatedAt, state: {}, audit: async () => {} });
assert.deepEqual(echoReads, ['Alice']); echoFixture.close();
const owner = { pid: process.pid, runId: 'run-a' }, heartbeat = join(DATA_DIR, 'heartbeat.json');
writeFileSync(heartbeat, JSON.stringify({ ...owner, at: new Date().toISOString() }));
assert.equal(ownerActive(owner), true);
writeFileSync(heartbeat, JSON.stringify({ ...owner, runId: 'run-b', at: new Date().toISOString() }));
assert.equal(ownerActive(owner), false, 'same PID from a different run cannot authorize old broker work');
writeFileSync(heartbeat, JSON.stringify({ ...owner, at: new Date().toISOString() }));
writeFileSync(join(DATA_DIR, 'STOP'), 'stop');
assert.equal(ownerActive(owner), false, 'stop revokes queued work immediately');
rmSync(join(DATA_DIR, 'STOP')); rmSync(heartbeat);
const nonblocking = agentStore(':memory:'), controller = new AbortController();
let polls = 0, duringModel = 0, modelWaiting = false;
await runEngine({ store: nonblocking, signal: controller.signal,
  configLoader: async () => ({ ...config, gui: { port: 0 }, pollIntervalMs: 250 }), profileLoader: async () => '',
  client: { unread: async () => { polls++; if (modelWaiting) duringModel++; if (polls >= 4) controller.abort(); return ['Bob']; },
    read: async () => ({ messages: [{ id: 'running', author: 'Bob', text: 'test', time: new Date().toISOString() }] }),
    markRead: async () => ({ verified: true, state: 'read', attempted: true }) },
  handle: async () => { modelWaiting = true; await new Promise(r => setTimeout(r, 800)); modelWaiting = false; return { ok: true, actions: [] }; } });
assert.ok(duringModel >= 2, 'Model wait must not block polling');
nonblocking.close();
console.log('PASS ordered intake, archive, reactions, exact action destination, fresh permission and uncertain no-retry');
