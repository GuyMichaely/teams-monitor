import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentStore } from '../src/agent/store.mjs';
import { agentAPI } from '../src/agent/api.mjs';
import { invocationViewHTML } from '../src/dashboard-invocations.mjs';
import { startGui } from '../src/gui-server.mjs';
import { CONFIG_FILE } from '../src/local-paths.mjs';

const store = agentStore(':memory:');
const at = (offset = 0) => Date.now() + offset;
const record = (runId, kind, value) => store.record(runId, kind, value);
const query = (messageId, running = false) => agentAPI({
  url: new URL(`/api/agent/invocations?messageId=${encodeURIComponent(messageId)}`, 'http://localhost'),
  method: 'GET', body: {}, store, running,
});

try {
  const msgA = store.observe('Fixture chat', { id: 'fixture-message-A', author: 'Jordan', time: new Date(at()).toISOString(), text: 'Fixture only.' }, true);
  const msgB = store.observe('Other chat', { id: 'fixture-message-B', author: 'Casey', time: new Date(at(1)).toISOString(), text: 'Separate fixture.' }, true);
  assert(msgA && msgB);

  // Two policy runs for one message, including replay; first run has both a
  // named continuation and a fresh call in the same policy invocation.
  record('policy-named-fresh', 'policy_input', { handler: 'handle', context: { trigger: 'message', messageId: msgA, text: 'Fixture only.' }, source: 'policy-v1', version: 'v1', replay: false });
  record('llm-named-1', 'agent_input', { policyRunId: 'policy-named-fresh', conversationId: 'project:alpha', input: 'Inspect this fixture.', instructions: 'Use the saved named history.', permissions: { readChats: ['Fixture chat'] } });
  record('llm-named-1', 'agent_result', { policyRunId: 'policy-named-fresh', conversationId: 'project:alpha', ok: true, history: [{ role: 'assistant', content: 'named result' }], output: 'Named answer.' });
  record('llm-fresh', 'agent_input', { policyRunId: 'policy-named-fresh', conversationId: null, input: 'Start fresh.', instructions: 'No prior history.', permissions: {} });
  record('llm-fresh', 'agent_result', { policyRunId: 'policy-named-fresh', conversationId: null, ok: true, history: [{ role: 'assistant', content: 'fresh result' }], output: 'Fresh answer.' });
  record('llm-named-2', 'agent_input', { policyRunId: 'policy-named-fresh', conversationId: 'project:alpha', input: 'Continue after the fresh call.', instructions: 'Continue explicitly.', permissions: {} });
  record('llm-named-2', 'agent_result', { policyRunId: 'policy-named-fresh', conversationId: 'project:alpha', ok: true, history: [{ role: 'assistant', content: 'second named result' }], output: 'Second named answer.' });
  record('policy-named-fresh', 'policy_result', { value: { actions: [], decision: 'fixture accepted' } });

  record('policy-replay', 'policy_input', { handler: 'handle', context: { trigger: 'message', messageId: msgA }, source: 'policy-v2', version: 'v2', replay: true });
  record('llm-replay-failed', 'agent_input', { policyRunId: 'policy-replay', conversationId: 'project:alpha', input: 'Replay call.', instructions: 'Fixture replay.' });
  record('llm-replay-failed', 'agent_result', { policyRunId: 'policy-replay', conversationId: 'project:alpha', ok: false, history: [{ role: 'user', content: 'Replay call.' }], error: { code: 'PROVIDER_ERROR', message: 'fixture failure' } });
  record('policy-replay', 'policy_failed', { error: { code: 'POLICY_ERROR', message: 'fixture replay failure' } });

  // A live policy invocation with one running call and one history-only retained
  // result. That result deliberately has no corresponding agent_input.
  record('policy-live', 'policy_input', { handler: 'handle', context: { trigger: 'message', messageId: msgB }, source: 'policy-v1', version: 'v1', replay: false });
  record('llm-live', 'agent_input', { policyRunId: 'policy-live', conversationId: 'conversation:live', input: 'Still working.', instructions: 'Wait for completion.' });
  record('policy-incomplete', 'policy_input', { handler: 'handle', context: { trigger: 'message', messageId: msgB }, source: 'policy-old', version: 'old', replay: false });
  record('llm-history-only', 'agent_result', { policyRunId: 'policy-incomplete', conversationId: 'conversation:history-only', ok: true, history: [{ role: 'assistant', content: 'retained history only' }], output: 'History-only output.' });
  record('policy-incomplete', 'policy_result', { value: 'unusual retained decision' });
  record('policy-interrupted', 'policy_input', { handler: 'handle', context: { trigger: 'message', messageId: msgB }, source: 'policy-v1', version: 'v1', replay: false });
  record('llm-interrupted', 'agent_input', { policyRunId: 'policy-interrupted', conversationId: 'conversation:interrupted', input: 'Interrupted before a result.', instructions: 'Fixture incomplete call.' });

  // Malformed shapes are represented through the store API without raw SQL or
  // edits to runtime state. A huge output exercises the explicit truncation.
  record('policy-corrupt', 'policy_input', { handler: 'handle', context: { trigger: 'message', messageId: msgA }, source: { broken: true }, version: 'bad', replay: false });
  record('llm-corrupt', 'agent_input', { policyRunId: 'policy-corrupt', conversationId: null, input: { unexpected: true }, instructions: 'Fixture malformed values.' });
  record('llm-corrupt', 'agent_result', { policyRunId: 'policy-corrupt', conversationId: null, ok: true, history: [], output: 'x'.repeat(250_000) });
  record('llm-corrupt', 'trace_event', ['not', 'an', 'object']);
  record('policy-corrupt', 'policy_result', { value: { done: true } });

  const first = await query(msgA);
  assert.equal(first.messageId, msgA);
  assert.deepEqual(new Set(first.runs.map(run => run.runId)), new Set(['policy-named-fresh', 'policy-replay', 'policy-corrupt']));
  const combined = first.runs.find(run => run.runId === 'policy-named-fresh');
  assert.equal(combined.status, 'completed');
  assert.equal(combined.source, 'policy-v1');
  assert.equal(combined.context.messageId, msgA);
  assert.deepEqual(combined.invocations.map(call => call.runId).sort(), ['llm-fresh', 'llm-named-1', 'llm-named-2']);
  assert.equal(combined.invocations.find(call => call.runId === 'llm-named-1').conversationId, 'project:alpha');
  assert.equal(combined.invocations.find(call => call.runId === 'llm-fresh').conversationId, null, 'omitted conversation remains a fresh call');
  assert.equal(combined.invocations.find(call => call.runId === 'llm-named-2').input, 'Continue after the fresh call.');

  const replay = first.runs.find(run => run.runId === 'policy-replay');
  assert.equal(replay.replay, true);
  assert.equal(replay.status, 'failed');
  assert.equal(replay.invocations[0].status, 'failed');
  assert.equal(replay.invocations[0].error.code, 'PROVIDER_ERROR');
  assert.deepEqual(replay.invocations[0].history, [{ role: 'user', content: 'Replay call.' }]);

  const corrupt = first.runs.find(run => run.runId === 'policy-corrupt');
  const huge = corrupt.invocations.find(call => call.runId === 'llm-corrupt').output;
  assert.equal(huge.truncated, true);
  assert(typeof huge.excerpt === 'string' && huge.excerpt.length <= 60_000);
  assert(corrupt.invocations[0].events.some(event => event.kind === 'invalid_log'), 'malformed event is shown as invalid log format');
  assert(corrupt.invocations[0].input && typeof corrupt.invocations[0].input === 'object', 'unexpected structured input remains inspectable');

  store.current({ runId: 'policy-live', startedAt: new Date(at()).toISOString() });
  const second = await query(msgB, true);
  const live = second.runs.find(run => run.runId === 'policy-live');
  assert.equal(live.status, 'running');
  assert.equal(live.invocations[0].status, 'running');
  const incomplete = second.runs.find(run => run.runId === 'policy-incomplete');
  assert.equal(incomplete.status, 'completed');
  const historyOnly = incomplete.invocations[0];
  assert.equal(historyOnly.input, null, 'history-only result without agent_input has no fabricated prompt');
  assert.deepEqual(historyOnly.history, [{ role: 'assistant', content: 'retained history only' }]);
  assert.equal(historyOnly.output, 'History-only output.');
  const interrupted = second.runs.find(run => run.runId === 'policy-interrupted');
  assert.equal(interrupted.status, 'incomplete');
  assert.equal(interrupted.invocations[0].status, 'incomplete');
  assert.deepEqual((await query('message-with-no-runs')).runs, []);

  const html = invocationViewHTML({ runs: [
    { runId: 'render-ok', replay: false, decision: {}, source: 'const policy = "</script><script>alert(1)</script> & ";', context: { note: '<img src=x onerror=alert(2)>' }, invocations: [{
      runId: 'render-fresh', status: 'completed', conversationId: null, startedAt: Date.now(),
      history: [
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ prompt: 'Fresh request JSON', context: { note: 'fixture' }, code: 'return "ok";' }) }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Assistant response from the fresh call.' }] },
      ], output: 'Assistant response from the fresh call.',
    }, {
      runId: 'render-failed', status: 'failed', conversationId: 'named:failure', startedAt: Date.now(),
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ prompt: 'Failed request is retained.' }) }] }],
      error: { code: 'PROVIDER_ERROR', message: 'fixture' },
    }, {
      runId: 'render-truncated', status: 'incomplete', conversationId: null,
      input: { truncated: true, excerpt: 'partial request fixture' }, history: { truncated: true, excerpt: 'partial history fixture' },
      events: [{ kind: 'invalid_log', value: { error: 'Invalid log format' } }],
    }] },
  ] });
  assert(html.includes('Policy request') && html.includes('Fresh request JSON'));
  assert(html.includes('Assistant response from the fresh call.'), 'assistant response text is extracted from SDK content arrays');
  assert(html.includes('Failed request is retained.') && html.includes('PROVIDER_ERROR'), 'failed invocation still renders its request and error');
  assert(html.includes('truncated') && html.includes('partial request fixture') && html.includes('Invalid log format'));
  assert(!html.includes('<script>') && !html.includes('<img'), 'source/context/transcript HTML is escaped');
  assert(html.includes('&lt;script&gt;') && html.includes('&lt;img'));

  // Exercise the real GUI auth boundary without initializing its database or
  // contacting Teams/model/phone. The unauthenticated request is rejected first.
  const config = Bun.YAML.parse(await readFile(CONFIG_FILE, 'utf8'));
  const port = 19000 + Math.floor(Math.random() * 10000);
  process.env.INVOCATION_SMOKE_TOKEN = 'invocation-smoke-token';
  config.gui = { ...config.gui, host: '127.0.0.1', port, authTokenEnv: 'INVOCATION_SMOKE_TOKEN' };
  const { server, close } = startGui(config);
  try {
    if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/invocations?messageId=${encodeURIComponent(msgA)}`);
    assert.equal(response.status, 401);
    const request = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: 'Bearer invocation-smoke-token', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const created = await request('/api/schedules', 'POST', { kind: 'status', presence: 'away', dueAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(created.status, 201);
    const schedule = await created.json();
    const status = await (await request('/api/agent/status')).json();
    const action = status.actions.find(row => row.id === 'schedule:' + schedule.id);
    assert.equal(action.state, 'pending'); assert.equal(action.value.presence, 'away');
    assert.equal(action.source, 'schedule'); assert(Number.isFinite(action.due));
    assert(!action.messageId, 'manual schedule has no invented originating message');
    assert.equal((await request('/api/schedules/' + schedule.id + '/cancel', 'POST')).status, 200);
    const afterCancel = await (await request('/api/agent/status')).json();
    assert.equal(afterCancel.actions.find(row => row.id === action.id).state, 'cancelled');
  } finally {
    await close();
  }

  console.log('Agent invocation inspector passed: call grouping, fresh/named histories, replay/failure/live snapshots, malformed/history-only records, truncation, message isolation, safe rendering and GUI authentication.');
} finally {
  store.close();
}
