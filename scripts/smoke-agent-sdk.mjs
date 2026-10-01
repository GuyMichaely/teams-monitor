import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Usage, tool } from '@openai/agents';
import { runAgent, agentTool } from '../src/agent/runtime.mjs';
import { GeminiModel, geminiRequest, geminiResponse, geminiContents } from '../src/agent/gemini-model.mjs';
import { AgentRuntimeError } from '../src/agent/errors.mjs';
import { AGENT_ACTIVITY_FILE } from '../src/agent/activity.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const call = (name, args = '{}') => ({ type: 'function_call', callId: 'call-1', name, arguments: args });
const response = output => ({ output, usage: new Usage({ requests: 1 }) });
const resultValue = input => {
  const result = input.find(item => item.type === 'function_call_result');
  return JSON.parse(typeof result.output === 'string' ? result.output : result.output.text);
};

const globalFetch = globalThis.fetch;
let unexpectedNetwork = 0;
globalThis.fetch = () => { unexpectedNetwork++; throw new Error('Unexpected network request'); };
try {
  let called = 0, requests = 0;
  const events = [];
  const echo = agentTool({ name: 'probe', description: 'Read a test marker.', parameters: z.object({ label: z.string() }), execute: ({ label }) => { called++; return { label }; } });
  const mocked = { async getResponse(request) {
    assert.equal(request.tracing, false);
    requests++;
    return response(requests === 1 ? [call('probe', '{"label":"private-input"}')] : [message(resultValue(request.input).label)]);
  } };
  const good = await runAgent({ model: mocked, tools: [echo], input: 'private-prompt', onActivity: event => events.push(event) });
  assert.equal(good.ok, true);
  assert.equal(good.output, 'private-input');
  assert.equal(called, 1);
  assert.equal(good.usage.requests, 2);
  assert(good.history.some(item => item.type === 'function_call_result'));
  assert(events.some(event => event.kind === 'tool_started'));
  assert.equal(events.at(-1).kind, 'run_completed');

  // Conversion through the real SDK must preserve all parts/signatures and IDs.
  const parts = [
    { text: 'private-thought', thought: true, thoughtSignature: 'signature-before-tool' },
    { functionCall: { name: 'probe', id: 'gemini-call', args: { label: 'gemini-marker' } }, thoughtSignature: 'signature-on-tool' },
  ];
  let providerRequests = 0;
  const gemini = new GeminiModel({ apiKey: 'private-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(options.headers['x-goog-api-key'], 'private-key');
    assert(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    providerRequests++;
    assert.equal(body.tools[0].functionDeclarations[0].name, 'probe');
    assert.equal(body.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
    assert.equal(body.toolConfig.functionCallingConfig.mode, providerRequests === 1 ? 'ANY' : 'AUTO');
    if (providerRequests === 2) {
      assert.deepEqual(body.contents[1], { role: 'model', parts });
      assert.deepEqual(body.contents[2].parts[0].functionResponse, { name: 'probe', id: 'gemini-call', response: { label: 'gemini-marker' } });
    }
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: providerRequests === 1 ? parts : [{ text: 'gemini-marker', thoughtSignature: 'final-signature' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 6 } });
  } });
  const converted = await runAgent({ model: gemini, tools: [echo], input: 'read marker', modelSettings: { toolChoice: 'required' } });
  assert.equal(converted.ok, true, JSON.stringify(converted.error));
  assert.equal(converted.output, 'gemini-marker');
  assert.equal(converted.usage.totalTokens, 12);
  assert.equal(providerRequests, 2);
  // History is portable JSON for a later session, including provider metadata.
  assert.deepEqual(geminiContents(JSON.parse(JSON.stringify(converted.history)))[1].parts, parts);
  assert.equal(geminiContents(converted.history).at(-1).parts[0].thoughtSignature, 'final-signature');

  const forbidden = await runAgent({ model: { getResponse: async () => response([call('not_available')]) }, tools: [echo], input: 'probe' });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'INVALID_MODEL_OUTPUT');
  assert.equal(called, 2);

  for (const args of ['{broken', '{"label":42}', '{"other":"value"}']) {
    let turns = 0;
    const malformed = await runAgent({ tools: [echo], input: 'probe', model: { getResponse: async request => {
      if (++turns === 1) return response([call('probe', args)]);
      assert.equal(resultValue(request.input).error.code, 'INVALID_TOOL_CALL');
      return response([message('Handled invalid call')]);
    } } });
    assert.equal(malformed.ok, true, `${args}: ${JSON.stringify(malformed.error)}; turns=${turns}`);
    assert.equal(called, 2, 'Invalid arguments must not execute the tool');
  }

  const deniedTool = agentTool({ name: 'denied', description: 'Permission denial fixture.', parameters: z.object({}), execute: () => { throw new AgentRuntimeError('PERMISSION_DENIED', 'Chat is not permitted.'); } });
  let deniedTurns = 0;
  const denied = await runAgent({ tools: [deniedTool], input: 'probe', model: { getResponse: async request => {
    if (++deniedTurns === 1) return response([call('denied')]);
    assert.equal(resultValue(request.input).error.code, 'PERMISSION_DENIED');
    return response([message('Handled denial')]);
  } } });
  assert.equal(denied.ok, true);

  let attempts = 0;
  const rejected = await runAgent({ input: 'private-prompt', model: new GeminiModel({ apiKey: 'private-key', fetchImpl: async () => {
    attempts++; return Response.json({ error: { message: 'private-key private-prompt' } }, { status: 503 });
  } }) });
  assert.deepEqual(rejected.error, { code: 'PROVIDER_ERROR', message: 'Gemini rejected the request.', httpStatus: 503 });
  assert.equal(attempts, 1, 'Provider requests are not silently retried');
  const offline = await runAgent({ input: 'probe', model: new GeminiModel({ apiKey: 'private-key', fetchImpl: async () => { throw new Error('private-key'); } }) });
  assert.equal(offline.error.code, 'PROVIDER_ERROR');
  for (const body of [null, {}, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }, { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }]) {
    const bad = await runAgent({ input: 'probe', model: new GeminiModel({ apiKey: 'private-key', fetchImpl: async () => Response.json(body) }) });
    assert.equal(bad.error.code, 'INVALID_MODEL_OUTPUT');
  }
  const invalidJson = await runAgent({ input: 'probe', model: new GeminiModel({ apiKey: 'private-key', fetchImpl: async () => new Response('{not JSON') }) });
  assert.equal(invalidJson.error.code, 'INVALID_MODEL_OUTPUT');
  assert.throws(() => geminiResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'probe', args: [] } }] } }] }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => geminiRequest({ input: 'x', tools: [{ type: 'hosted_tool' }], outputType: 'text' }), { code: 'UNSUPPORTED_MODEL_FEATURE' });
  assert.throws(() => geminiContents([{ role: 'user', content: [{ type: 'input_image' }] }]), { code: 'UNSUPPORTED_MODEL_FEATURE' });

  const deadlineEvents = [];
  const timeoutStarted = Date.now();
  const timeout = await runAgent({ timeoutMs: 20, input: 'probe', tools: [echo], onActivity: e => deadlineEvents.push(e), model: { getResponse: async () => { await wait(80); return response([call('probe', '{"label":"late"}')]); } } });
  assert.equal(timeout.error.code, 'TIMEOUT');
  assert(Date.now() - timeoutStarted < 70, 'Deadline must not wait for a non-cooperative provider');
  await wait(100);
  assert.equal(called, 2, 'Late model output must not invoke a tool');
  assert.equal(deadlineEvents.at(-1).kind, 'run_failed');
  assert.equal(deadlineEvents.filter(e => e.kind === 'run_failed').length, 1);

  const controller = new AbortController();
  const cancelledRun = runAgent({ input: 'probe', signal: controller.signal, model: { getResponse: () => new Promise(() => {}) } });
  controller.abort();
  assert.equal((await cancelledRun).error.code, 'CANCELLED');
  assert.equal((await runAgent({ input: 'probe', signal: controller.signal, model: mocked })).error.code, 'CANCELLED');
  const endless = await runAgent({ input: 'probe', tools: [echo], maxTurns: 1, model: { getResponse: async () => response([call('probe', '{"label":"bounded"}')]) } });
  assert.equal(endless.error.code, 'TURN_LIMIT');
  assert.equal((await runAgent({ input: 'x', model: mocked, timeoutMs: 0 })).error.code, 'INVALID_CONFIG');
  const unguarded = tool({ name: 'unguarded', description: 'Do not execute.', parameters: z.object({}), execute: () => { throw new Error('unguarded executed'); } });
  assert.equal((await runAgent({ input: 'x', model: mocked, tools: [unguarded] })).error.code, 'INVALID_CONFIG');
  assert.equal((await runAgent({ input: 'x', config: { brain: { provider: 'other' } } })).error.code, 'INVALID_CONFIG');
  assert.equal((await runAgent({ input: 'x', config: { brain: { apiKeyEnv: 'NO_SUCH_SMOKE_KEY' } } })).error.code, 'MISSING_CREDENTIALS');

  const diagnosticFailure = await runAgent({ input: 'x', model: { getResponse: async () => response([message('ok')]) }, onActivity: async () => { throw new Error('diagnostic failure'); } });
  assert.equal(diagnosticFailure.ok, true);
  const logs = readFileSync(AGENT_ACTIVITY_FILE, 'utf8');
  for (const privateValue of ['private-key', 'private-prompt', 'private-input', 'private-thought', 'signature-on-tool']) assert(!logs.includes(privateValue));
  for (const line of logs.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(unexpectedNetwork, 0, 'SDK tracing/export must not make network requests');
  console.log('Agent SDK smoke passed: Bun tool loop, Gemini conversion/signatures, errors, deadlines, limits and local-only diagnostics.');
} finally { globalThis.fetch = globalFetch; }
