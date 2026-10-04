import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { reactionMessages } from '../src/reaction-messages.mjs';
import { agentStore } from '../src/agent/store.mjs';
import { intake, messageContext } from '../src/agent/intake.mjs';
import { scan } from '../src/agent/engine.mjs';
import { convertAutomationToPolicy } from './lib/convert-policy.mjs';
import { evaluatePolicy, savePolicy, POLICY_FILE } from '../src/agent/policy.mjs';

const activation = '2026-09-30T12:00:00.000Z';
const oldMessage = { id: 'original-123', author: 'Alex', time: '2026-09-25T12:00:00Z', text: 'Hi @TM', mentions: ['TM'], reactions: [] };
const like = { key: 'like', emoji: '👍', count: 1, self: false };
const baselineEntry = {};
assert.deepEqual(reactionMessages([{ ...oldMessage, reactions: [like] }], baselineEntry, activation), [], 'first observation is only a baseline');
assert.deepEqual(reactionMessages([{ ...oldMessage, reactions: [like] }], baselineEntry, activation), [], 'unchanged badges do not replay');
const delta = reactionMessages([{ ...oldMessage, reactions: [{ ...like, count: 2 }] }], baselineEntry, activation, '2026-09-30T12:01:00Z');
assert.equal(delta.length, 1);
assert.equal(delta[0].author, 'Unknown reactor');
assert.match(delta[0].text, /Someone added 👍 to Alex's message/);
assert.deepEqual(delta[0].reaction, {
  key: 'like', emoji: '👍', change: 'added', count: 1, actorKnown: false,
  originalMessageId: 'original-123', originalAuthor: 'Alex', originalTime: oldMessage.time,
  originalText: oldMessage.text, observedAt: '2026-09-30T12:01:00Z',
  timing: 'Observed between polls; actual reaction time is unavailable',
});
const selfEntry = {};
assert.deepEqual(reactionMessages([{ ...oldMessage, reactions: [like] }], selfEntry, activation), []);
assert.deepEqual(reactionMessages([{ ...oldMessage, reactions: [{ ...like, count: 2, self: true }] }], selfEntry, activation), [], 'self reaction badge is excluded from other-reactor counts');
const removed = reactionMessages([{ ...oldMessage, reactions: [{ ...like, self: true }] }], selfEntry, activation);
assert.equal(removed[0].reaction.change, 'removed');
assert.equal(removed[0].reaction.count, 1);
assert.deepEqual(reactionMessages([{ ...oldMessage, reactions: [like] }], baselineEntry, 'new activation'), [], 'activation restart resets the baseline');

const store = agentStore(':memory:');
try {
  const config = { alerts: { mentionNames: ['TM', 'Alex'], ignoreAuthors: [] }, automation: { rules: [
    { id: 'direct', when: { type: 'direct_message' }, action: { type: 'alert_phone' } },
    { id: 'mention', when: { type: 'mention' }, action: { type: 'alert_phone' } },
    { id: 'reaction-observation', when: { type: 'reaction' }, action: { type: 'ignore' } },
  ] } };
  const entry = {};
  assert.deepEqual(intake({ store, chat: 'Alex', messages: [{ ...oldMessage, reactions: [like] }], config, activatedAt: activation, reactions: entry }), [], 'old original message stays outside the activation cutoff and reaction is baselined');
  assert.equal(entry.reactionSnapshot.activationId, activation);

  let readCount = 0;
  const state = { chats: { Project: entry } };
  await scan({ store, state, config, activatedAt: activation, client: {
    async unread() { return []; },
    async read(chat) { assert.equal(chat, 'Project'); readCount++; return { messages: [{ ...oldMessage, reactions: [{ ...like, count: 2 }] }] }; },
  }, audit: async () => {} });
  assert.equal(readCount, 1, 'scan revisits a previously observed chat with a reaction snapshot even if it is no longer unread');
  const row = store.claimMessage();
  assert(row?.value?.reaction, 'the newly observed badge delta enters the message queue');
  assert.equal(row.value.author, 'Unknown reactor');
  const context = messageContext(row, store, config, 'fixture profile');
  assert.equal(context.isDM, false, 'synthetic reaction author is never interpreted as a direct message');
  assert.equal(context.mentionsMe, false, 'reaction body text cannot create a mention');

  const source = convertAutomationToPolicy(config.automation, config.alerts);
  await savePolicy(source, POLICY_FILE);
  const evaluated = await evaluatePolicy(context, { store });
  assert.equal(evaluated.ok, true, JSON.stringify(evaluated.error));
  assert.deepEqual(evaluated.value.evaluations.map(item => [item.ruleId, item.matched]), [
    ['direct', false], ['mention', false], ['reaction-observation', true],
  ], 'reaction conditions match while DM and mention rules do not');
  assert.equal(evaluated.actions.length, 0, 'ignore is a no-op for its own rule');
  console.log('Agent reaction smoke passed: baseline, activation reset, revisit scan, synthetic identity and rule routing.');
} finally { store.close(); }
