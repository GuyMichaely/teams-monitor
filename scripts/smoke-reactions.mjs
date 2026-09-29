import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { reactionMessages } from '../src/reaction-messages.mjs';
import { processChat, tick } from '../src/orchestrator.mjs';
import { evaluateRules } from '../src/deterministic-rules.mjs';
import { registerAction } from '../src/actions.mjs';
import { saveState, ACTIVITY_LOG } from '../src/state.mjs';
import { readFile } from 'node:fs/promises';

const activation = '2026-09-28T12:00:00.000Z';
const message = { id: '123', author: 'Alex', time: '2026-09-25T12:00:00Z', text: 'Hi @Guy', mentions: ['Guy'], reactions: [] };
const like = { key: 'like', emoji: '👍', count: 1, self: false };
const entry = {};
assert.deepEqual(reactionMessages([{ ...message, reactions: [like] }], entry, activation), [], 'initial history is baseline');
assert.deepEqual(reactionMessages([{ ...message, reactions: [like] }], entry, activation), []);
let changes = reactionMessages([{ ...message, reactions: [{ ...like, count: 2 }] }], entry, activation);
assert.equal(changes.length, 1);
assert.equal(changes[0].author, 'Unknown reactor');
assert.match(changes[0].text, /Someone added 👍 to Alex's message/);
assert.equal(changes[0].reaction.originalTime, message.time);
assert.deepEqual(reactionMessages([{ ...message, reactions: [{ ...like, count: 3, self: true }] }], entry, activation), [], 'own reaction excluded');
changes = reactionMessages([{ ...message, reactions: [{ ...like, self: true }] }], entry, activation);
assert.equal(changes[0].reaction.count, 2);
assert.equal(changes[0].reaction.change, 'removed');
assert.deepEqual(reactionMessages([{ ...message, reactions: [like] }], entry, 'new activation'), [], 'restart never replays reaction backlog');
assert.doesNotThrow(() => reactionMessages([message], { reactionSnapshot: { activationId: activation, messages: { 123: { reactions: { like: { count: 'bad' } } } } } }, activation));

const config = { alerts: { mentionNames: ['Guy'] }, automation: { rules: [
  { id: 'direct', when: { type: 'direct_message' }, action: { type: 'alert_phone' } },
  { id: 'mention', when: { type: 'mention' }, action: { type: 'alert_phone' } },
  { id: 'reactions', when: { type: 'reaction' }, action: { type: 'ignore' } },
] } };
const evaluations = evaluateRules({ chat: 'Unknown reactor', latest: changes[0], config });
assert.deepEqual(evaluations.map(r => r.matched), [false, false, true], 'quoted @mention and direct-chat identity cannot turn reactions into DMs');
let alerts = 0;
registerAction({ name: 'alert_phone', run: async () => { alerts++; } });
const state = { chats: {} };
let messages = [message];
const io = { readChat: async () => ({ messages }) };
const args = { chat: 'Alex', config, brain: {}, state, activatedAt: activation, io };
assert.equal(await processChat(args), 'before_activation');
assert.equal(alerts, 0, 'Friday messages must not alarm after Monday activation');
messages = [{ ...message, reactions: [like] }];
assert.equal(await processChat(args), 'handled');
assert.equal(alerts, 0, 'reaction must not re-alert original direct message');
const records = (await readFile(ACTIVITY_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(records.filter(r => r.kind === 'flow' && r.stage === 'message').length, 1);
assert.equal(records.find(r => r.stage === 'message').latest.reaction.originalMessageId, '123');
await processChat(args);
assert.equal(alerts, 0);
messages = [{ ...message, id: '124', time: activation, text: 'new message', reactions: [] }];
await processChat(args);
assert.equal(alerts, 1, 'message at activation boundary is eligible');
messages = [{ ...messages[0], time: null }];
assert.equal(await processChat(args), 'invalid_time');
assert.equal(alerts, 1);

const llmState = { chats: {} };
const triageConfig = { ...config, automation: {
  rules: config.automation.rules.filter(r => r.id !== 'reactions'),
  agent: { initiate: { when: 'unmatched', actions: ['alert_phone'] } },
} };
let llmInput;
const llmArgs = { ...args, config: triageConfig, state: llmState, brain: { reviewPlan: async input => {
  llmInput = input;
  return { changes: [], additions: [], reason: 'Reaction needs no alert' };
} } };
messages = [message];
await processChat(llmArgs);
messages = [{ ...message, reactions: [like] }];
await processChat(llmArgs);
assert.equal(llmInput.latest.reaction.originalAuthor, 'Alex');
assert.equal(llmInput.latest.author, 'Unknown reactor');
assert.equal(alerts, 1, 'unmatched reaction review does not manufacture a protected DM action');

await saveState(state);
let read = false;
await tick({ config, brain: {}, activatedAt: activation, io: { getUnreadChats: async () => [], readChat: async () => { read = true; return { messages }; } } });
assert(read, 'one already observed chat is revisited even without unread flag');
console.log('Reaction baseline/deltas, self exclusion, rule routing, activation boundary and read-chat revisit passed.');
