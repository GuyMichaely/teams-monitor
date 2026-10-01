import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { runAgent, agentTool } from '../src/agent/runtime.mjs';
import { NvidiaModel } from '../src/agent/nvidia-model.mjs';
import { configuredModel } from '../src/agent/model.mjs';
import { NVIDIA_MODEL, NVIDIA_ENDPOINT } from '../src/nvidia-api.mjs';
import { AGENT_ACTIVITY_FILE } from '../src/agent/activity.mjs';

const completion = message => ({ id: 'synthetic', choices: [{ index: 0, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const call = (name = 'probe', args = '{"label":"marker"}') => ({ id: 'call-nvidia', type: 'function', function: { name, arguments: args } });
const previousFetch = globalThis.fetch;
const previousKey = process.env.NVIDIA_API_KEY;
let unexpectedNetwork = 0;
globalThis.fetch = () => { unexpectedNetwork++; throw Error('Unexpected network'); };
process.env.NVIDIA_API_KEY = 'private-key';
try {
  let executions = 0, requests = 0;
  const probe = agentTool({ name: 'probe', description: 'Read a synthetic marker.', parameters: z.object({ label: z.string() }), execute: ({ label }) => { executions++; return { label }; } });
  const model = configuredModel({ brain: { provider: 'nvidia' } }, { fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, NVIDIA_ENDPOINT);
    assert.equal(options.headers.Authorization, 'Bearer private-key');
    assert(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, NVIDIA_MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.tool_choice, requests === 1 ? 'required' : undefined);
    assert.equal(body.tools[0].function.name, 'probe');
    assert(!JSON.stringify(body).includes('outputSchema'));
    if (requests === 2) {
      assert(body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call-nvidia' && m.content.includes('marker')));
    }
    return Response.json(completion(requests === 1 ? { content: null, tool_calls: [call()] } : { content: 'marker' }));
  } });
  const result = await runAgent({ model, tools: [probe], input: 'private-prompt', modelSettings: { toolChoice: 'required' } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.output, 'marker');
  assert.equal(executions, 1);
  assert.equal(requests, 2);
  assert.equal(result.usage.totalTokens, 10);
  assert(result.history.some(item => item.type === 'function_call_result'));

  // Native NVIDIA and earlier provider histories both retain portable context.
  for (const history of [result.history, [
    { role: 'user', content: 'Old marker request' },
    { type: 'reasoning', content: [], providerData: { geminiPart: { text: 'private-thought', thought: true, thoughtSignature: 'private-signature' } } },
    { type: 'function_call', name: 'probe', callId: 'old-call', arguments: '{"label":"old-marker"}', providerData: { geminiPart: { functionCall: { name: 'probe', args: { label: 'old-marker' } } } } },
    { type: 'function_call_result', name: 'probe', callId: 'old-call', output: '{"label":"old-marker"}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old-marker' }], providerData: { geminiPart: { text: 'old-marker' } } },
  ]]) {
    const resumed = await runAgent({ model: new NvidiaModel({ apiKey: 'private-key', fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert(!JSON.stringify(body).includes('geminiPart'));
      assert(!JSON.stringify(body).includes('private-thought'));
      assert(body.messages.some(m => m.role === 'tool'));
      return Response.json(completion({ content: 'Continued' }));
    } }), input: [...history, { role: 'user', content: 'Continue' }] });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  }
  for (const status of [401, 429, 503]) {
    let attempts = 0;
    const failed = await runAgent({ input: 'private-prompt', model: new NvidiaModel({ apiKey: 'private-key', fetchImpl: async () => {
      attempts++; return Response.json({ error: { message: 'private-key private-prompt' } }, { status });
    } }) });
    assert.deepEqual(failed.error, { code: 'PROVIDER_ERROR', message: 'NVIDIA rejected the request.', httpStatus: status });
    assert.equal(attempts, 1);
  }
  for (const body of [null, {}, { ...completion({ content: 'partial', tool_calls: [call()] }), choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial', tool_calls: [call()] } }] }, completion({ content: '' })]) {
    const invalid = await runAgent({ input: 'probe', tools: [probe], model: new NvidiaModel({ apiKey: 'private-key', fetchImpl: async () => Response.json(body) }) });
    assert.equal(invalid.error.code, 'INVALID_MODEL_OUTPUT');
    assert.equal(executions, 1, 'Incomplete response cannot invoke tools');
  }
  const unavailable = await runAgent({ input: 'probe', tools: [probe], model: new NvidiaModel({ apiKey: 'private-key', fetchImpl: async () => Response.json(completion({ content: null, tool_calls: [call('not_available')] })) }) });
  assert.equal(unavailable.error.code, 'INVALID_MODEL_OUTPUT');
  assert.equal(executions, 1);
  let turns = 0;
  const malformedArgs = await runAgent({ input: 'probe', tools: [probe], model: new NvidiaModel({ apiKey: 'private-key', fetchImpl: async (_url, options) => {
    if (++turns === 1) return Response.json(completion({ content: null, tool_calls: [call('probe', '{"label":42}')] }));
    assert(JSON.parse(options.body).messages.some(m => m.role === 'tool' && m.content.includes('INVALID_TOOL_CALL')));
    return Response.json(completion({ content: 'Handled invalid call' }));
  } }) });
  assert.equal(malformedArgs.ok, true);
  assert.equal(executions, 1, 'Local argument validation remains effective');
  let cancelledSignal;
  const timeout = await runAgent({ input: 'probe', tools: [probe], timeoutMs: 20, model: new NvidiaModel({ apiKey: 'private-key', fetchImpl: async (_url, options) => {
    cancelledSignal = options.signal;
    await new Promise(resolve => setTimeout(resolve, 80));
    return Response.json(completion({ content: null, tool_calls: [call()] }));
  } }) });
  assert.equal(timeout.error.code, 'TIMEOUT');
  assert(cancelledSignal.aborted);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(executions, 1, 'Late output cannot execute');
  assert.throws(() => configuredModel({ brain: { provider: 'nvidia', apiKeyEnv: 'NO_SUCH_NVIDIA_SMOKE_KEY' } }), { code: 'MISSING_CREDENTIALS' });
  const logs = readFileSync(AGENT_ACTIVITY_FILE, 'utf8');
  for (const secret of ['private-key', 'private-prompt', 'private-thought', 'private-signature']) assert(!logs.includes(secret));
  assert.equal(unexpectedNetwork, 0, 'No SDK trace export or unintended network access');
  console.log('NVIDIA SDK smoke passed: real converter/tool loop, portable history, sanitized errors/no retries, local validation, unavailable tools, abort/late exclusion and local-only diagnostics.');
} finally {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = previousKey;
}
