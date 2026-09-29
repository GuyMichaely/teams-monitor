import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { applyAgentPlan, decideWithRules } from '../src/rule-policy.mjs';

const rule = (id, type = 'alert_phone', agent = {}) => ({ id, when: { field: 'text', match: 'contains', value: 'urgent' }, action: type === 'reply' ? { type, text: `reply ${id}` } : { type }, agent });
const input = (automationRules, extra = {}) => ({ chat: 'Alex', latest: { author: 'Alex', text: 'urgent, please' }, config: { automation: { rules: automationRules } }, whitelisted: false, ...extra });
const emptyPlan = { changes: [], additions: [], reason: 'keep configured plan' };

// All matching actions survive; initiation policy can add only explicitly permitted types.
let received;
const multi = await decideWithRules(input([rule('one'), rule('two', 'ignore')], { config: { automation: { rules: [rule('one'), rule('two', 'ignore')], agent: { initiate: { when: 'always', actions: ['alert_phone', 'reply'] } } } } }), {
  async reviewPlan(value) { received = value.rulePlan; return emptyPlan; },
});
assert.deepEqual(multi.ruleActions.map(x => [x.ruleId, x.outcome]), [['one', 'retained'], ['two', 'retained']]);
assert.deepEqual(received.allowedAdditions, ['alert_phone']);
assert.equal(received.replyAllowed, false);

// A reply whitelist cannot authorize reply initiation or bypass a blocked configured reply.
let reviewerCalled = false;
const blockedReply = await decideWithRules(input([rule('reply-rule', 'reply', { modify: true })], { whitelisted: false }), {
  async reviewPlan() { reviewerCalled = true; return { changes: [{ ruleId: 'reply-rule', operation: 'modify', action: { type: 'reply', text: 'sneak' }, reason: 'try' }], additions: [], reason: 'try' }; },
});
assert.equal(blockedReply.ruleActions[0].outcome, 'blocked_reply_policy');
assert.equal(reviewerCalled, false);
assert.deepEqual(blockedReply.ruleActions.map(x => x.action.type), ['reply']);
const cannotInitiateReply = await decideWithRules({ ...input([]), config: { automation: { agent: { initiate: { when: 'always', actions: ['reply'] } } } } }, {
  async reviewPlan() { throw new Error('must not call reviewer'); },
});
assert.deepEqual(cannotInitiateReply.ruleActions, []);
const cannotSmuggleReply = await decideWithRules({ ...input([]), config: { automation: { agent: { initiate: { when: 'always', actions: ['alert_phone'] } } } } }, {
  async reviewPlan() { return { changes: [], additions: [{ action: { type: 'reply', text: 'sneak' }, reason: 'try' }], reason: 'try' }; },
});
assert.deepEqual(cannotSmuggleReply.ruleActions, []);

const protectedInput = (permissions = {}) => input([rule('protected', 'alert_phone', permissions)]);
for (const change of [
  { ruleId: 'protected', operation: 'modify', action: { type: 'reply', text: 'change type' }, reason: 'modify' },
  { ruleId: 'protected', operation: 'modify', action: { type: 'alert_phone', text: 'change target', target: 'other' }, reason: 'modify' },
]) {
  const result = await decideWithRules(protectedInput({ modify: true }), { async reviewPlan() { return { changes: [change], additions: [], reason: 'unauthorized attempt' }; } });
  assert.equal(result.ruleActions[0].outcome, 'fallback');
  assert.deepEqual(result.ruleActions[0].action, { type: 'alert_phone' });
}
let forbiddenCancelCalled = false;
const forbiddenCancel = await decideWithRules(protectedInput(), { async reviewPlan() { forbiddenCancelCalled = true; return { ...emptyPlan, changes: [{ ruleId: 'protected', operation: 'cancel', reason: 'no permission' }] }; } });
assert.equal(forbiddenCancelCalled, false);
assert.equal(forbiddenCancel.ruleActions[0].outcome, 'bypassed');

const allowed = await decideWithRules(input([rule('cancel-ok', 'alert_phone', { cancel: true }), rule('modify-ok', 'alert_phone', { modify: true })]), {
  async reviewPlan() { return { changes: [
    { ruleId: 'cancel-ok', operation: 'cancel', reason: 'duplicate' },
    { ruleId: 'modify-ok', operation: 'modify', action: { type: 'alert_phone', text: 'short summary' }, reason: 'clarify' },
  ], additions: [], reason: 'reviewed' }; },
});
assert.deepEqual(allowed.ruleActions.map(x => x.outcome), ['cancelled', 'modified']);

const initiation = await decideWithRules({ ...input([]), config: { automation: { agent: { initiate: { when: 'unmatched', actions: ['alert_phone'] } } } } }, {
  async reviewPlan(plan) { assert.deepEqual(plan.rulePlan.allowedAdditions, ['alert_phone']); return { changes: [], additions: [{ action: { type: 'alert_phone', text: 'urgent summary' }, reason: 'needs attention' }], reason: 'reviewed' }; },
});
assert.equal(initiation.ruleActions[0].outcome, 'initiated');

// Initiation is independent from per-rule edits, and never implied by whitelist access.
for (const when of ['never', 'unmatched']) {
  const stopped = await decideWithRules({ ...input([rule('matched')]), whitelisted: true, config: { automation: { rules: [rule('matched')], agent: { initiate: { when, actions: ['reply', 'alert_phone'] } } } } }, {
    reviewPlan() { throw Error('No review authority applies'); },
  });
  assert.deepEqual(stopped.ruleActions.map(p => p.outcome), ['bypassed']);
}
// A valid change followed by an invalid change is rejected atomically.
const proposals = [
  { ruleId: 'editable', action: { type: 'reply', text: 'Original' }, permissions: { cancel: true, modify: true }, outcome: 'proposed' },
  { ruleId: 'hard', action: { type: 'alert_phone' }, permissions: { cancel: false, modify: false }, outcome: 'proposed' },
];
const original = structuredClone(proposals);
for (const operation of ['cancel', 'modify']) {
  const denied = { ruleId: 'hard', operation, reason: 'Try protected action', ...(operation === 'modify' ? { action: { type: 'alert_phone', text: 'changed' } } : {}) };
  assert.throws(() => applyAgentPlan({ ...emptyPlan, changes: [{ ruleId: 'editable', operation: 'cancel', reason: 'Valid' }, denied] }, proposals, [], true));
  assert.deepEqual(proposals, original);
}
for (const [permissions, operation] of [[{ cancel: true, modify: false }, 'modify'], [{ cancel: false, modify: true }, 'cancel']]) {
  assert.throws(() => applyAgentPlan({ ...emptyPlan, changes: [{ ruleId: 'editable', operation, reason: 'Not allowed', ...(operation === 'modify' ? { action: { type: 'reply', text: 'change' } } : {}) }] }, [{ ...proposals[0], permissions }], [], true));
}
assert.throws(() => applyAgentPlan({ ...emptyPlan, additions: [{ action: { type: 'reply', text: 'Blocked' }, reason: 'Try' }] }, [], ['reply'], false));

for (const badPlan of [null, {}, { ...emptyPlan, reason: '' }, { ...emptyPlan, additions: [{ action: { type: 'reply', text: 'unauthorized' }, reason: 'x' }] }, { ...emptyPlan, changes: [{ ruleId: 'missing', operation: 'cancel', reason: 'x' }] }]) {
  const result = await decideWithRules(input([rule('safe', 'alert_phone', { modify: true })]), { async reviewPlan() { return badPlan; } });
  assert.deepEqual(result.ruleActions.map(x => [x.ruleId, x.outcome, x.action]), [['safe', 'fallback', { type: 'alert_phone' }]]);
}

// Reviewer timeout retains configured actions, rejects late output, and suppresses late traces.
let release, lateTraceCount = 0, errors = 0, reviewSignal;
const timed = await decideWithRules({ ...input([rule('timed', 'alert_phone', { modify: true })]), config: { automation: { rules: [rule('timed', 'alert_phone', { modify: true })], agent: { timeoutMs: 20 } } } }, {
  reviewPlan(_value, trace) { reviewSignal = _value.signal; return new Promise(resolve => { release = () => { trace.onInput({ late: true }); trace.onOutput({ late: true }); resolve({ ...emptyPlan, additions: [{ action: { type: 'alert_phone' }, reason: 'late' }] }); }; }); },
}, { onInput: value => { if (value.late) lateTraceCount++; }, onOutput: value => { if (value.late) lateTraceCount++; }, onReviewError: () => errors++ });
assert.equal(timed.ruleActions[0].outcome, 'fallback');
assert.equal(errors, 1);
assert.equal(reviewSignal.aborted, true);
release(); await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(lateTraceCount, 0);
assert.deepEqual(timed.ruleActions.map(x => x.ruleId), ['timed']);

// Errors in observability callbacks cannot change permissions or action delivery.
const traceSafe = await decideWithRules(input([rule('trace-safe')]), { async reviewPlan() { return emptyPlan; } }, { onRules() { throw new Error('trace failure'); }, onDecision() { throw new Error('trace failure'); } });
assert.equal(traceSafe.ruleActions[0].outcome, 'bypassed');
console.log('smoke-rule-policy: ok');
