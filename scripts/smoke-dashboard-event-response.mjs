import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { buildActivityGroups } from '../src/dashboard-activity.mjs';
import { eventResponseHTML } from '../src/dashboard-event-response.mjs';

const at = seconds => new Date(seconds * 1000).toISOString();
const flow = (stage, seconds, fields = {}) => ({
  kind: 'flow', flowId: 'event-1', flowStartedAt: at(1), chat: 'Build room', stage, at: at(seconds), ...fields,
});

// Activity snapshots survive grouping and represent the newest merged policy state.
const activity = buildActivityGroups([
  flow('effect', 8, { effect: 'none', status: 'ignored' }),
  flow('decision', 7.5, { action: 'rule_actions', reason: 'No action selected' }),
  flow('policy', 6, { source: 'javascript', attributes: { stage: 'response', priority: 2 } }),
  flow('policy', 4, { source: 'javascript', attributes: { stage: 'triage' } }),
  flow('message', 1, { latest: { author: 'Alice', text: 'Please review this build.' } }),
]);
assert.equal(activity.length, 1);
const group = activity[0];
assert.equal(group.invalid, undefined);
assert.deepEqual(group.attributes, { stage: 'response', priority: 2 });
assert.deepEqual(group.events.filter(event => event.attributes).map(event => event.attributes), [
  { stage: 'triage' }, { stage: 'response', priority: 2 },
]);
assert.deepEqual(group.icons, [], 'no-action outcomes do not display action emoji');
assert.deepEqual(group.outcomes, ['ignore']);

// The response combines activity, policy attributes, several model calls and
// scheduled action state in chronological order.
const response = eventResponseHTML(group, {
  runs: [{
    runId: 'policy-run', startedAt: at(2), completedAt: at(10), status: 'failed', replay: false,
    source: 'export async function handle(ctx) { return ctx.message.text; }',
    context: { message: { author: 'Alice', text: 'Please review this build.' } },
    attributes: { stage: 'response', priority: 2 },
    attributeUpdates: [
      { seq: 20, at: at(4), attributes: { stage: 'triage' } },
      { seq: 24, at: at(6), attributes: { stage: 'response', priority: 2 } },
    ],
    error: { code: 'POLICY_FAULT', message: 'A later policy step failed.' },
    invocations: [
      { runId: 'model-failed', startedAt: at(3), completedAt: at(5), status: 'failed', error: { code: 'PROVIDER_ERROR', message: 'provider unavailable' }, events: [] },
      { runId: 'model-timeout', startedAt: at(7), completedAt: at(9), status: 'failed', error: { code: 'TIMEOUT', message: 'model deadline elapsed' }, events: [] },
    ],
  }],
  actions: [{
    id: 'scheduled-1', created: Date.now() + 10000, due: Date.now() + 60000, state: 'pending', source: 'schedule', messageId: 'event-1',
    value: { kind: 'message', chat: 'Build room', text: 'I will review the build.' },
  }, {
    id: 'cancelled-1', created: Date.now() + 12000, due: Date.now() + 60000, state: 'cancelled', source: 'schedule', messageId: 'event-1',
    value: { kind: 'message', chat: 'Build room', text: 'Cancelled draft.' },
  }],
});
const title = text => `<strong>${text}</strong>`;
const position = text => response.indexOf(title(text));
const firstModel = position('LLM call · failed · 2.0 s');
const secondModel = response.indexOf(title('LLM call · failed · 2.0 s'), firstModel + 1);
assert(position('Observed in Teams') < position('Policy started'));
assert(position('Policy started') < firstModel);
assert(firstModel < position('Policy attributes updated'));
assert(position('Policy attributes updated') < secondModel);
assert(secondModel < position('Policy decision'));
assert(position('Policy decision') < position('Policy failed'));
const failedCall = response.indexOf('model-failed');
const timedOutCall = response.indexOf('model-timeout');
assert(failedCall >= 0 && timedOutCall > failedCall, 'both failed and timed-out model calls are retained in call order');
assert(response.includes('PROVIDER_ERROR') && response.includes('TIMEOUT'));
assert(response.includes('Scheduled message · Build room'));
assert(response.includes('Manual schedule'));
assert(response.includes('data-action-message="event-1"'), 'scheduled action links back to its source event');
assert(response.includes('data-action-cancel="scheduled-1"'), 'pending scheduled action has a cancel control');
assert(!response.includes('data-action-cancel="cancelled-1"'), 'cancelled action has no cancel control');

// Untrusted names and values are escaped in attribute tables and event headings.
const hostile = { ...group, chat: '<script>alert(1)</script>', attributes: { 'x"><img src=x>': '<img src=x onerror=alert(1)>' } };
const escaped = eventResponseHTML(hostile, { runs: [], actions: [] });
assert(!escaped.includes('<script>') && !escaped.includes('<img src=x'));
assert(escaped.includes('&lt;script&gt;') && escaped.includes('&lt;img src=x'));

// Truncated and malformed API fields should degrade safely without crashing.
for (const run of [
  { runId: 'truncated', status: 'completed', replay: false, attributeUpdates: { truncated: true, excerpt: '…' }, invocations: [] },
  { runId: 'malformed', status: 'failed', replay: false, attributeUpdates: [null, 'bad', { seq: 'x', at: 'not-a-date', attributes: [] }], invocations: [] },
]) {
  assert.doesNotThrow(() => eventResponseHTML(group, { runs: [run], actions: [] }));
}

console.log('Dashboard event response smoke passed: grouped attributes, chronology, model failures/timeouts, HTML escaping, scheduled links/cancellation, malformed updates, and no-action icons.');
