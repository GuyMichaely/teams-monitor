import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Usage } from '@openai/agents';
import { loadConfig } from '../src/context.mjs';
import { agentStore } from '../src/agent/store.mjs';
import { evaluatePolicy, savePolicy } from '../src/agent/policy.mjs';

const source = await readFile(new URL('../automation/policy.alert-review.ts', import.meta.url), 'utf8');
await savePolicy(source);
const config = await loadConfig();
config.agent = { ...config.agent, policyTimeoutMs: 10_000, timeoutMs: 5_000 };
const ctx = { trigger: 'message', messageId: 'review-fixture', now: new Date().toISOString(),
  chatName: 'Alice', authorName: 'Alice', isDM: true, mentionsMe: false, reaction: null,
  message: { author: 'Alice', text: 'Please review this.', time: new Date().toISOString(), mentions: [] },
  history: [], userProfile: '', brief: '', mentionNames: ['Me'] };
const reply = text => ({ output: [{ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }] }], usage: new Usage({ requests: 1 }) });
const modelFor = (output, expectedContext = ctx) => ({ async getResponse(request) {
  const content = request.input.at(-1).content;
  const payload = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text).join(''));
  assert.equal(payload.policy.source, source, 'review sees the exact evaluated source');
  assert.deepEqual(payload.context, expectedContext, 'review sees the supplied variable values');
  assert.equal(payload.proposals.length, 0, 'only policy code may create the chosen alert after review');
  assert(payload.prompt.includes(String(expectedContext.isDM || expectedContext.mentionsMe)), 'review sees the computed heuristic result');
  for (const field of ['tools', 'readChats', 'writeChats', 'initiateActions', 'cancelIds'])
    assert.deepEqual(payload.permissions[field], [], field + ' is denied');
  assert.deepEqual(payload.permissions.modifyIds, {});
  assert.equal(payload.conversationId, null, 'each review has fresh model history');
  assert.deepEqual(request.tools.map(t => t.name), ['execute_bun'], 'only the existing isolated computation tool remains; no host tools');
  return reply(output);
} });
const check = async (context, model, expected, settings = config) => {
  const store = agentStore(':memory:');
  try {
    const result = await evaluatePolicy(context, { store, model, configLoader: async () => settings });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.actions.filter(action => !action.cancelled).length, Number(expected), JSON.stringify(result.value));
    assert.equal(result.value.alert, expected);
    const request = store.records(100).find(record => record.kind === 'agent_input');
    assert.equal(request?.value.policyRunId, result.runId, 'request is linked to the policy invocation before model completion');
    assert.equal(JSON.parse(request.value.input.at(-1).content).context.messageId, context.messageId);
    assert.equal(typeof request.value.instructions, 'string', 'actual system instructions are retained even on timeout');
    assert.equal(store.actions().length, 0, 'tests stage effects only; nothing is sent');
    return result;
  } finally { store.close(); }
};

assert.equal((await check(ctx, modelFor('ALERT'), true)).value.decidedBy, 'llm');
assert.equal((await check(ctx, modelFor(' NO_ALERT\n'), false)).value.decidedBy, 'llm');
assert.equal((await check(ctx, modelFor('No alert please'), true)).value.decidedBy, 'heuristics');
assert.equal((await check(ctx, { async getResponse() { throw Error('fixture failure'); } }, true)).value.decidedBy, 'heuristics');
const unmatched = { ...ctx, isDM: false };
await check(unmatched, modelFor('ALERT', unmatched), true);
await check(unmatched, modelFor('NO_ALERT', unmatched), false);
await check(unmatched, modelFor('invalid', unmatched), false);
await check(unmatched, { async getResponse() { throw Error('fixture failure'); } }, false);
const mention = { ...ctx, isDM: false, mentionsMe: true };
await check(mention, modelFor('NO_ALERT', mention), false);

// Bound a non-cooperative provider; a late veto must never cancel the fallback.
const started = Date.now();
const delayed = { async getResponse() { await new Promise(resolve => setTimeout(resolve, 250)); return reply('NO_ALERT'); } };
const fallback = await check(ctx, delayed, true, { ...config, agent: { ...config.agent, timeoutMs: 40 } });
assert(Date.now() - started < 1500, 'bounded review returns before the late model veto');
assert.equal(fallback.value.review, 'TIMEOUT');
await check(unmatched, delayed, false, { ...config, agent: { ...config.agent, timeoutMs: 40 } });
await new Promise(resolve => setTimeout(resolve, 300));
assert.equal(fallback.actions[0].cancelled, undefined, 'late output cannot mutate the fallback plan');
console.log('PASS exact policy/context/heuristic input, denied host permissions, both-way decisions, DM/mention/no-match, malformed/failure fallback, bounded timeout and late output isolation.');
