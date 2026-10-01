import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { requestNvidia, validateNvidiaCompletion, NVIDIA_MODEL, NVIDIA_ENDPOINT, brainApiKeyEnv } from '../src/nvidia-api.mjs';
import { createBrain } from '../src/brain.mjs';
import { decideWithRules } from '../src/rule-policy.mjs';
import { dashboardHealth } from '../src/dashboard-health.mjs';

const completion = (content, finish = 'stop') => ({ id: 'synthetic', choices: [{ finish_reason: finish, message: { role: 'assistant', content } }] });
const plan = { changes: [], additions: [], reason: 'Keep configured actions' };
const previousFetch = globalThis.fetch;
const previousKey = process.env.NVIDIA_API_KEY;
process.env.NVIDIA_API_KEY = 'private-nvidia-key';
try {
  let attempts = 0, captured;
  globalThis.fetch = async (url, options) => {
    attempts++; captured = JSON.parse(options.body);
    assert.equal(url, NVIDIA_ENDPOINT);
    assert.equal(options.headers.Authorization, 'Bearer private-nvidia-key');
    assert(options.signal instanceof AbortSignal);
    assert.equal(captured.stream, false);
    return Response.json(completion(JSON.stringify(plan)));
  };
  assert.equal(brainApiKeyEnv({ brain: { provider: 'nvidia' } }), 'NVIDIA_API_KEY');
  assert.equal(brainApiKeyEnv({ brain: { provider: 'gemini' } }), 'GEMINI_API_KEY');
  assert.equal(brainApiKeyEnv({ brain: { provider: 'nvidia', apiKeyEnv: 'CUSTOM' } }), 'CUSTOM');
  const events = [];
  const config = { brain: { provider: 'nvidia' } };
  const brain = createBrain(config);
  assert.deepEqual(await brain.reviewPlan({ chat: 'Fictional', latest: { text: 'Synthetic' }, rulePlan: {} }, {
    onInput: value => events.push(value), onOutput: value => events.push(value),
  }), plan);
  assert.equal(captured.model, NVIDIA_MODEL);
  assert.equal(captured.response_format.type, 'json_object');
  assert.match(captured.messages[0].content, /UNTRUSTED/);
  assert.deepEqual(events.map(e => e.provider), ['nvidia', 'nvidia']);
  for (const status of [401, 429, 503]) {
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return Response.json({ error: { message: 'private-nvidia-key private-message' } }, { status }); };
    await assert.rejects(brain.reviewPlan({}), error => {
      assert.equal(error.code, 'PROVIDER_ERROR'); assert.equal(error.details.httpStatus, status);
      assert(!JSON.stringify(error).includes('private-nvidia-key')); assert(!error.message.includes('private-message')); return true;
    });
    assert.equal(attempts, 1, 'No implicit provider retries');
  }
  const guarded = { ...config, automation: { rules: [{ id: 'protected', when: { type: 'direct_message' }, action: { type: 'alert_phone' } }], agent: { initiate: { when: 'always', actions: ['alert_phone'] } } } };
  const decision = await decideWithRules({ config: guarded, chat: 'Fictional', latest: { author: 'Fictional', text: 'Synthetic' } }, createBrain(guarded));
  assert.equal(decision.ruleActions.length, 1);
  assert.equal(decision.ruleActions[0].action.type, 'alert_phone');
  assert.equal(decision.ruleActions[0].outcome, 'fallback');
  for (const body of [null, {}, completion('partial', 'length'), completion('', 'stop'), completion('blocked', 'content_filter'), completion('x', 'tool_calls'), { choices: [completion('x').choices[0], completion('y').choices[0]] }])
    assert.throws(() => validateNvidiaCompletion(body), { code: 'INVALID_MODEL_OUTPUT' });
  const badCall = { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'a', type: 'custom' }] } }] };
  assert.throws(() => validateNvidiaCompletion(badCall), { code: 'INVALID_MODEL_OUTPUT' });
  globalThis.fetch = async () => new Response('{broken');
  await assert.rejects(brain.reviewPlan({}), { code: 'INVALID_MODEL_OUTPUT' });
  globalThis.fetch = async () => { throw Error('private-nvidia-key private-message'); };
  await assert.rejects(brain.reviewPlan({}), { code: 'PROVIDER_ERROR', message: 'NVIDIA could not be reached.' });
  const controller = new AbortController();
  attempts = 0;
  globalThis.fetch = async (_url, options) => { attempts++; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('private abort')), { once: true })); };
  const pending = requestNvidia({ apiKey: 'private-nvidia-key', body: { model: NVIDIA_MODEL }, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(attempts, 1);
  await assert.rejects(requestNvidia({ body: { model: NVIDIA_MODEL } }), { code: 'MISSING_CREDENTIALS' });
  await assert.rejects(requestNvidia({ apiKey: 'x', body: { model: '../invalid' } }), { code: 'INVALID_CONFIG' });
  globalThis.fetch = async () => Response.json([]);
  assert.equal((await dashboardHealth(config)).brain.configured, true);
  assert.equal((await dashboardHealth(config)).brain.model, NVIDIA_MODEL);
  delete process.env.NVIDIA_API_KEY;
  assert.equal((await dashboardHealth(config)).brain.configured, false, 'Gemini credentials do not satisfy NVIDIA health');
  console.log('NVIDIA smoke passed: JSON reviews, default/custom key env, protected-action fallback, HTTP failures, no retries, invalid/truncated output and cancellation.');
} finally {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = previousKey;
}
