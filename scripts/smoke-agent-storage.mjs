import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { agentStore, messageKey } from '../src/agent/store.mjs';
import { operationQueue } from '../src/teams-queue.mjs';
import { teamsOperation } from '../src/teams-broker.mjs';

const store = agentStore();
try {
  const now = Date.now();
  const a = { id: 'first', author: 'Alex', time: new Date(now).toISOString(), text: 'one' };
  const b = { id: 'second', author: 'Alex', time: new Date(now + 1).toISOString(), text: 'two' };
  const first = store.observe('Alex', a, true);
  const second = store.observe('Alex', b, true);
  assert(first && second);
  assert.equal(store.observe('Alex', a, true), null);
  assert.equal(messageKey('Alex', a), messageKey(' alex ', { ...a, text: 'edited' }), 'Message ID prevents edited-content replay');
  assert.equal(store.claimMessage().id, first);
  store.finishMessage(first);
  assert.equal(store.claimMessage().id, second);
  store.recover(new Date(now + 10).toISOString());
  assert.equal(store.message(second).state, 'uncertain');
  assert.equal(store.claimMessage(), null);
  assert.equal(store.history('Alex').length, 2);
  assert.equal(store.search('one', 'Alex').length, 1);
  assert.equal(Object.hasOwn(store.conversations()[0], 'coverage'), false);

  store.plan('run', [{ id: 'interrupted', kind: 'message', due: now }, { id: 'future', kind: 'status', due: now + 60000 }]);
  const attempt = store.claimAction(now);
  assert.equal(attempt.id, 'interrupted');
  store.recover(new Date(now + 10).toISOString());
  assert.equal(store.actions().find(a => a.id === 'interrupted').state, 'uncertain');
  assert.equal(store.claimAction(now), null, 'Interrupted actions do not retry');
  assert.equal(store.cancel('future'), true);
  assert.equal(store.cancel('interrupted'), false);
  store.record('run', 'test', { ok: true });
  assert.equal(store.records()[0].value.ok, true);

  const queue = operationQueue(), order = [];
  await Promise.all([
    queue.run(async () => { order.push('read'); await new Promise(r => setTimeout(r, 10)); order.push('read-complete'); }),
    queue.run(() => { order.push('send'); throw Error('test'); }).catch(() => {}),
    queue.run(() => order.push('status')),
  ]);
  assert.deepEqual(order, ['read', 'read-complete', 'send', 'status']);
  let sends = 0, checks = 0;
  const cfg = { port: 19222, replyPolicy: { mode: 'whitelist', entries: ['Alex'] } };
  const io = { config: async () => { checks++; return cfg; }, send: async (chat, text, port, guard) => { assert.equal(chat, 'Alex'); assert.equal(text, 'hello'); await guard(); sends++; return 'sent'; } };
  assert.deepEqual(await teamsOperation({ operation: 'send', chat: 'Alex', text: 'hello', expiresAt: now + 60000 }, io), { result: 'sent' });
  assert.equal(sends, 1); assert.equal(checks, 3);
  cfg.replyPolicy.entries = [];
  await assert.rejects(teamsOperation({ operation: 'send', chat: 'Alex', text: 'hello', expiresAt: now + 60000 }, io), error => error.scheduleCode === 'blocked');
  assert.equal(sends, 1);
  console.log('Agent storage/broker groundwork passed: ordered claims, ID dedupe, uncertainty recovery, serialization and fresh permissions.');
} finally { store.close(); }
