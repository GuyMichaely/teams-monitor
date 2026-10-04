import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { convertAutomationToPolicy } from './lib/convert-policy.mjs';
import { evaluateRules } from '../src/deterministic-rules.mjs';

async function loadPolicy(automation, options) {
  const source = convertAutomationToPolicy(automation, options);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const alerts = [], sends = [], llmCalls = [];
const api = {
  async alert(payload) { alerts.push(payload); return { ok: true, id: `alert-${alerts.length}`, state: 'pending' }; },
  async sendMessage(chat, text) { sends.push({ chat, text }); return { ok: true, id: `message-${sends.length}`, state: 'pending' }; },
  async llm(prompt, options) { llmCalls.push({ prompt, options }); return { ok: true, output: 'reviewed' }; },
};

const policy = await loadPolicy({
  rules: [
    { id: 'nested-direct', when: { all: [{ type: 'direct_message' }, { field: 'text', match: 'contains', value: 'urgent' }] }, action: { type: 'alert_phone' } },
    { id: 'duplicate-alert', when: { any: [{ type: 'mention' }, { field: 'author', match: 'exact', value: 'Alice' }] }, action: { type: 'alert_phone' } },
    { id: 'reply', when: { field: 'text', match: 'contains_number', value: '42' }, action: { type: 'reply', text: 'answer' }, agent: { cancel: true, modify: true } },
  ],
  agent: { initiate: { when: 'never', actions: [] } },
}, { mentionNames: ['TM Bot'] });

const result = await policy.handle({
  message: { author: 'Alice', text: 'urgent @TM Bot 42', mentions: ['TM Bot'], time: '2026-09-30T12:00:00Z' },
  chatName: 'Alice', isDM: true, mentionsMe: true, history: [], userProfile: 'fixture',
}, api);
assert.equal(result.ok, true);
assert.equal(result.evaluations.filter(item => item.matched).length, 3, 'nested all/any, direct message, mention and numeric field match');
assert.equal(alerts.length, 1, 'identical deterministic phone alerts are deduplicated');
assert.equal(sends.length, 1, 'matching reply rule proposes one message');
assert.equal(llmCalls.length, 1);
assert.deepEqual(llmCalls[0].options.tools.includes('cancel_action'), true);
assert.deepEqual(llmCalls[0].options.tools.includes('modify_action'), true);
assert.deepEqual(llmCalls[0].options.tools.includes('send_message'), false, 'initiate never grants no new message tool');
assert.deepEqual(llmCalls[0].options.tools.includes('alert'), false, 'initiate never grants no new alert tool');
assert.equal(llmCalls[0].options.initiateActions.length, 0);
assert.equal(Object.keys(llmCalls[0].options.modifyIds).length, 1);
assert.deepEqual(Object.values(llmCalls[0].options.modifyIds)[0], ['text'], 'reply modification grants only the message text field');
assert.equal(llmCalls[0].options.cancelIds.length, 1);

const deniedPolicy = await loadPolicy({ rules: [
  { id: 'denied', when: { field: 'text', match: 'exact', value: 'send' }, action: { type: 'reply', text: 'blocked' } },
] });
const denied = await deniedPolicy.handle({ message: { author: 'Bob', text: 'send' }, chatName: 'Bob' }, {
  async sendMessage() { return { ok: false, error: { code: 'REPLY_DENIED', message: 'Reply policy blocks this chat.' } }; },
});
assert.equal(denied.proposals.length, 1);
assert.equal(denied.proposals[0].result.ok, false, 'denied reply remains a structured result for policy handling');
assert.equal(denied.permissions.cancelIds.length, 0, 'denied reply has no action handle to cancel');
assert.equal(denied.permissions.modifyIds && Object.keys(denied.permissions.modifyIds).length, 0, 'denied reply has no action handle to modify');

const initiationPolicy = await loadPolicy({
  rules: [],
  agent: { initiate: { when: 'unmatched', actions: ['reply', 'alert_phone'] }, timeoutMs: 1234 },
});
await initiationPolicy.handle({ message: { author: 'Bob', text: 'hello' }, chatName: 'Bob' }, api);
const initiation = llmCalls.at(-1).options;
assert.equal(initiation.timeoutMs, 1234);
assert.deepEqual(initiation.initiateActions, ['message', 'alert']);
assert.deepEqual(initiation.writeChats, ['Bob']);
assert.equal(initiation.tools.includes('send_message'), true);
assert.equal(initiation.tools.includes('alert'), true);

async function compareRuleMatches(automation, context, mentionNames = [], ignoreAuthors = []) {
  const converted = await loadPolicy(automation, { mentionNames, ignoreAuthors });
  const convertedResult = await converted.handle(context, {
    async alert() { return { ok: true, id: 'match-check', state: 'pending' }; },
    async sendMessage() { return { ok: true, id: 'match-check', state: 'pending' }; },
  });
  const existing = evaluateRules({
    chat: context.chatName,
    latest: context.message,
    config: { automation, alerts: {
      mentionNames: context.mentionNames ?? mentionNames,
      ignoreAuthors: context.ignoreAuthors ?? ignoreAuthors,
    } },
  });
  assert.deepEqual(
    convertedResult.evaluations.map(({ ruleId, matched }) => [ruleId, matched]),
    existing.map(({ rule, matched }) => [rule.id, matched]),
  );
  return convertedResult;
}

const dmRule = { id: 'dm', when: { type: 'direct_message' }, action: { type: 'alert_phone' } };
const ignoredDm = await compareRuleMatches({ rules: [dmRule] }, {
  message: { author: 'Blocked Person', text: 'hello' }, chatName: 'Blocked Person', isDM: true,
}, [], ['Blocked Person']);
assert.equal(ignoredDm.proposals.length, 0, 'ignored-author DM is not alerted');

const emptyRules = await compareRuleMatches({ rules: [] }, {
  message: { author: 'Alice', text: 'hello' }, chatName: 'Alice', isDM: true,
});
assert.equal(emptyRules.proposals.length, 0, 'empty rules do not synthesize a DM alert');

const disabledRules = await compareRuleMatches({ rules: [{ ...dmRule, enabled: false }] }, {
  message: { author: 'Alice', text: 'hello' }, chatName: 'Alice', isDM: true,
});
assert.equal(disabledRules.proposals.length, 0, 'disabled DM rules do not synthesize alerts');

const customAlertAutomation = { rules: [
  { id: 'default-alert', when: { field: 'text', match: 'exact', value: 'hello' }, action: { type: 'alert_phone' } },
  { id: 'custom-matches-default', when: { type: 'mention' }, action: { type: 'alert_phone', text: 'hello' } },
  { id: 'custom-text', when: { field: 'author', match: 'exact', value: 'Alice' }, action: { type: 'alert_phone', text: 'custom summary' } },
] };
const beforeCustom = alerts.length;
const customPolicy = await loadPolicy(customAlertAutomation, { mentionNames: ['old name'] });
const customContext = {
  message: { author: 'Alice', text: 'hello', mentions: ['TM Bot'] }, chatName: 'Alice',
  // Current config context takes precedence over names captured at conversion.
  mentionNames: ['TM Bot'], ignoreAuthors: [],
};
const customResult = await customPolicy.handle(customContext, api);
await compareRuleMatches(customAlertAutomation, customContext, ['old name'], []);
assert.equal(customResult.proposals.length, 2, 'custom and default alerts with the same effective text dedupe');
assert.equal(alerts.length - beforeCustom, 2, 'the default-equivalent group and distinct custom summary each run once');
assert.deepEqual(alerts.slice(-2).map(item => item.body).sort(), ['custom summary', 'hello']);
assert(alerts.slice(-2).every(item => typeof item.title === 'string' && !('chat' in item) && !('text' in item) && !('author' in item)), 'phone proposals use only title/body');
assert.equal(customResult.evaluations.find(item => item.ruleId === 'custom-matches-default').matched, true, 'dynamic mentions replace captured names');
await compareRuleMatches({ rules: [
  { id: 'mention', when: { type: 'mention' }, action: { type: 'alert_phone' } },
] }, {
  message: { author: 'Alice', text: 'hey @TM Bot', mentions: [] }, chatName: 'Group', mentionNames: ['TM Bot'],
}, ['old name'], []);

console.log('Policy conversion smoke passed: existing-rule fidelity, deduplication, denied reply, custom alerts, and bounded agent authority.');

// Conversion is explicit and idempotent; ordinary runtime bootstrap only creates the current template.
{
  const { loadConfig, saveConfig } = await import('../src/context.mjs');
  const { ensurePolicy, POLICY_FILE } = await import('../src/agent/policy.mjs');
  const { migrateAgentPolicy } = await import('./migrate-agent-policy.mjs');
  const { readFile, unlink } = await import('node:fs/promises');
  const { agentStore } = await import('../src/agent/store.mjs');
  const { DATA_DIR } = await import('../src/local-paths.mjs');
  const { Database } = await import('bun:sqlite');
  const { join } = await import('node:path');
  const config = await loadConfig();
  config.automation = { rules: [dmRule] };
  config.alerts = { ...config.alerts, ignoreAuthors: ['Blocked Person'], notifyAll: true };
  await saveConfig(config);
  await ensurePolicy();
  assert((await loadConfig()).automation, 'bootstrap does not load or migrate old YAML rules');
  await unlink(POLICY_FILE);
  const store = agentStore();
  const original = { id: 'legacy-badge', text: 'hello', author: 'Alice', time: new Date().toISOString(), mentions: [], reactions: [{ key: 'like', emoji: '👍', count: 1, self: false }] };
  store.observe('Alice', original);
  const recordedId = store.history('Alice')[0].id;
  store.close();
  const db = new Database(join(DATA_DIR, 'agent', 'store.sqlite'));
  db.exec('DROP TABLE reaction_snapshots'); db.close();
  assert.deepEqual(await migrateAgentPolicy(), { migrated: true, snapshots: 1 });
  const source = await readFile(POLICY_FILE, 'utf8');
  assert(source.includes('if (true) return actions.alert'), 'notifyAll is preserved in migrated code, not a runtime alias');
  assert(source.includes('Blocked Person'));
  const cleaned = await loadConfig();
  assert.equal(Object.hasOwn(cleaned, 'automation'), false);
  assert.equal(Object.hasOwn(cleaned.alerts, 'notifyAll'), false);
  assert.equal(Object.hasOwn(cleaned.alerts, 'ignoreAuthors'), false);
  const migrated = agentStore();
  try { assert.equal(migrated.reactions('Alice', recordedId).reactions[0].count, 1); } finally { migrated.close(); }
  assert.deepEqual(await migrateAgentPolicy(), { migrated: false, snapshots: 0 });
  assert.equal(await readFile(POLICY_FILE, 'utf8'), source);
  console.log('PASS explicit migration, runtime template only, config cleanup and stored reaction snapshot backfill.');
}
