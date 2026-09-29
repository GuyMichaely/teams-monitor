import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { processChat } from '../src/orchestrator.mjs';
import { registerAction } from '../src/actions.mjs';
import { ACTIVITY_LOG } from '../src/state.mjs';

const phoneRule = { id: 'mention', when: { type: 'mention' }, action: { type: 'alert_phone' } };
const replyRule = { id: 'number', when: { field: 'text', match: 'contains_number', value: '1234' }, action: { type: 'reply', text: 'Original' }, agent: { cancel: true, modify: true } };
const directRule = { id: 'direct', when: { type: 'direct_message' }, action: { type: 'alert_phone' } };
const latest = { author: 'Alex', text: '@Guy reference 1234.', time: '2026-09-24T12:00:00Z' };
const base = { alerts: { mentionNames: ['Guy'] }, replyPolicy: { mode: 'whitelist', entries: ['Alex'] }, automation: { rules: [phoneRule, replyRule, directRule] } };
const keep = { changes: [], additions: [], reason: 'Keep proposals' };
let sends = [], alerts = [], failReply = false, failPhone = false;
registerAction({ name: 'alert_phone', run: async args => { alerts.push(args); if (failPhone) throw Error('delivery failed'); return { sent: true }; } });
async function run(config = base, review = async () => keep, load = async () => config) {
  sends = []; alerts = [];
  await processChat({ chat: 'Alex', config, brain: { reviewPlan: review }, state: { chats: {} }, io: {
    readChat: async () => ({ messages: [latest] }), loadConfig: load,
    sendMessage: async text => { sends.push(text); if (failReply) throw Error('reply failed'); return 'sent'; },
  } });
}
await run(base, async input => {
  assert.equal(input.rulePlan.evaluations.length, 3);
  assert(input.rulePlan.evaluations.every(e => e.matched));
  return { ...keep, changes: [{ ruleId: 'number', operation: 'modify', action: { type: 'reply', text: 'Revised' }, reason: 'Context' }] };
});
assert.deepEqual(sends, ['Revised']); assert.equal(alerts.length, 1, 'overlapping direct/mention alerts deduplicated');
await run(base, async () => ({ ...keep, changes: [{ ruleId: 'number', operation: 'cancel', reason: 'Already answered' }] }));
assert.deepEqual(sends, []); assert.equal(alerts.length, 1, 'reply cancellation cannot cancel protected alert');
await run(base, async () => { throw Error('provider unavailable'); });
assert.deepEqual(sends, ['Original']); assert.equal(alerts.length, 1, 'failure retains original actions');
await run(base, async () => keep, async () => ({ ...base, replyPolicy: { mode: 'whitelist', entries: [] } }));
assert.deepEqual(sends, []); assert.equal(alerts.length, 1, 'revoked reply permission preserves alerts');
await run(base, async () => keep, async () => { throw Error('corrupt config'); });
assert.deepEqual(sends, []); assert.equal(alerts.length, 1, 'unreadable permission is fail-closed without blocking other actions');
failReply = true;
await run({ ...base, automation: { rules: [replyRule, phoneRule] } });
assert.equal(sends.length, 1); assert.equal(alerts.length, 1, 'reply failure does not stop a later alert');
failReply = false; failPhone = true;
await run();
assert.equal(sends.length, 1); assert.equal(alerts.length, 1, 'phone failure does not stop independent reply or cause a duplicate attempt');
failPhone = false;
await run({ ...base, replyPolicy: { mode: 'whitelist', entries: [] } }, async () => { throw Error('Blocked editable reply should not need review'); });
assert.deepEqual(sends, []); assert.equal(alerts.length, 1);
const records = (await readFile(ACTIVITY_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
assert(records.some(e => e.stage === 'policy' && e.ruleEvaluations?.length === 3));
assert(records.some(e => e.stage === 'decision' && e.ruleActions?.some(a => a.outcome === 'modified')));
assert(records.some(e => e.stage === 'decision' && e.ruleActions?.some(a => a.outcome === 'cancelled')));
assert(records.some(e => e.stage === 'error' && e.recovered));
assert(records.some(e => e.effect === 'teams_reply' && e.status === 'error'));
console.log('Rule execution: multiple actions, deduplication, edits/cancellations, fresh reply permissions, isolated failures and traces passed.');
