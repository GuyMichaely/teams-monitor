import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { Usage } from '@openai/agents';
import { agentStore } from '../src/agent/store.mjs';
import { evaluatePolicy, savePolicy } from '../src/agent/policy.mjs';
import { loadConfig } from '../src/context.mjs';
import { agentAPI } from '../src/agent/api.mjs';
import { agentReview } from '../src/agent/tools.mjs';
import { actionAPI, blankPlan } from '../src/agent/plan.mjs';
import { runEngine } from '../src/agent/engine.mjs';

const store = agentStore(':memory:');
const context = { trigger: 'message', messageId: 'source-event', contextId: 'chat:Alice', chatName: 'Alice', message: { text: 'incoming' } };
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const response = text => ({ output: [message(text)], usage: new Usage({ requests: 1 }) });
const configLoader = loadConfig;
const model = { getResponse: async () => response('first answer') };
const options = { tools: [], readChats: ['Alice'], conversationId: 'chosen' };
const review = (opts, plan = blankPlan(), custom = model) => agentReview({ options: opts, prompt: 'next', context, source: 'policy', version: 'version', plan, store, configLoader, model: custom });
const api = (path, method = 'GET', body = {}, running = false) => agentAPI({ url: new URL(path, 'http://localhost'), method, body, store, running });
try {
  await savePolicy(`export async function handle(ctx,a) { return a.llm('fresh', {tools:[],readChats:['Alice']}); }`);
  const fresh = await evaluatePolicy(context, { store, model });
  assert.equal(fresh.value.conversationId, null);
  assert.deepEqual(fresh.sessions, {}, 'incoming context ID must not implicitly create model history');
  store.commit(fresh.runId, fresh);
  assert.deepEqual(store.sessions(), []);

  const plan = blankPlan();
  await review(options, plan);
  let continued = false;
  await review({ ...options, tools: ['read_note'] }, plan, { getResponse: async request => {
    continued = request.input.some(i => i.role === 'assistant'); return response('second answer');
  } });
  assert(continued, 'two explicit same-ID calls in one handler share staged history');
  assert.equal(store.session('chosen').exists, false);
  store.commit('two-calls', plan);
  assert.equal(store.session('chosen').turns, 2);
  assert.equal(store.session('chosen').revision, 1);

  let leaked = false;
  const narrowed = blankPlan();
  await review({ ...options, readChats: [] }, narrowed, { getResponse: async request => {
    leaked = request.input.some(i => i.role === 'assistant'); return response('narrowed');
  } });
  assert(!leaked, 'changed read scope excludes prior history');
  let stillFresh = false;
  await review({ tools: [], readChats: ['Alice'] }, blankPlan(), { getResponse: async request => {
    stillFresh = !request.input.some(i => i.role === 'assistant'); return response('independent');
  } });
  assert(stillFresh, 'omitting ID never resumes the incoming chat or last named conversation');
  assert.equal((await review({ ...options, contextId: 'old' })).error.code, 'INVALID_INPUT');
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const special = blankPlan(); assert((await review({ ...options, conversationId: id }, special)).ok);
    store.commit('special-key', special); assert.equal(store.session(id).exists, true);
  }

  const concurrentPlan = blankPlan(); let seenTurns = [];
  await Promise.all([review(options, concurrentPlan, { getResponse: async request => { seenTurns.push(request.input.length); return response('one'); } }),
    review(options, concurrentPlan, { getResponse: async request => { seenTurns.push(request.input.length); return response('two'); } })]);
  assert(seenTurns[1] > seenTurns[0], 'same-plan concurrent invocations serialize');

  const stale = blankPlan(); await review(options, stale);
  stale.actions.push({ id: 'must-rollback', kind: 'alert', title: 'Fixture', body: 'not committed' });
  const queued = await api('/api/agent/intervene', 'POST', { conversationId: 'chosen', prompt: 'change direction' });
  assert(queued.ok);
  const work = store.claimWork();
  assert.equal(work.value.messageId, 'source-event', 'intervention stays attached to its originating event');
  assert.deepEqual(work.value.ceiling, store.session('chosen').permissions, 'intervention retains prior grant, not global maximum');
  const oldHistory = store.session('chosen').history;
  await api('/api/agent/conversation/reset', 'POST', { conversationId: 'chosen' });
  assert.throws(() => store.commit('stale', stale), /Conversation changed/);
  assert.equal(store.action('must-rollback'), null);
  assert.deepEqual(store.session('chosen').history, []);
  assert.deepEqual(store.sessionArchives('chosen')[0].value.previous.history, oldHistory);
  await savePolicy('export async function handle() {}');
  const resetWork = await evaluatePolicy({ ...work.value, trigger: 'intervention' }, { store, model, handler: 'onIntervention', savedCeiling: work.value.ceiling });
  assert.equal(resetWork.value.error.code, 'CONVERSATION_RESET');
  const intervention = await api('/api/agent/intervene', 'POST', { conversationId: 'chosen', prompt: 'try this instead' });
  assert(intervention.ok);
  const next = store.claimWork();
  const resumed = await evaluatePolicy({ ...next.value, trigger: 'intervention' }, { store, model, handler: 'onIntervention', savedCeiling: next.value.ceiling });
  assert.equal(resumed.value.conversationId, 'chosen');
  store.commit(resumed.runId, resumed, null, next.id);

  // A separate concurrent snapshot cannot overwrite a newer committed continuation.
  const a = blankPlan(), b = blankPlan(); await review(options, a); await review(options, b);
  store.commit('a', a); assert.throws(() => store.commit('b', b), /Conversation changed/);

  const wakePlan = blankPlan(), actions = actionAPI({ plan: wakePlan, context, configLoader, store }).api;
  const permissions = store.session('chosen').permissions, dueAt = new Date(Date.now() + 60000).toISOString();
  assert((await actions.wake('fresh wake', { dueAt, permissions })).ok);
  assert.equal(wakePlan.actions[0].conversationId, null);
  assert((await actions.wake('continue wake', { dueAt, permissions, conversationId: 'chosen' })).ok);
  assert.equal(wakePlan.actions[1].conversationEpoch, store.session('chosen').epoch);

  // Cancelling a non-cooperative model aborts the handler and discards earlier proposals.
  await savePolicy(`export async function handle(ctx,a) { await a.alert({title:'Fixture',body:'must not execute'}); return a.llm('wait', {tools:[],conversationId:'cancel'}); }`);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = evaluatePolicy(context, { store, model: { getResponse: async () => { entered(); return new Promise(() => {}); } } });
  await started;
  const active = store.current();
  assert.equal(active.conversationId, 'cancel');
  await api('/api/agent/run/cancel', 'POST', { runId: active.runId }, true);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'CANCELLED');
  assert.equal(store.session('cancel').exists, false);
  assert.equal(store.current(), null);
  await assert.rejects(api('/api/agent/intervene', 'POST', { conversationId: 'unknown', prompt: 'no new standalone chat' }));
  console.log('PASS explicit fresh/continued history, serialized calls, scope isolation, interventions, reset archives/CAS, wakes and run cancellation');
} finally { store.close(); }

// Exercise the queued intervention path through the real serialized engine.
const engineStore = agentStore(':memory:'), controller = new AbortController();
const ceiling = { tools: [], readChats: [], writeChats: [], initiateActions: [], cancelIds: [], modifyIds: {} };
engineStore.session('engine', { history: [], summary: '', permissions: ceiling, readChats: [] });
const oldEpoch = engineStore.session('engine').epoch;
engineStore.resetSession('engine');
let queued = false, calls = 0, resumedHistory = false;
const timeout = setTimeout(() => controller.abort(), 6000);
try {
  await savePolicy('export async function handle() {}');
  await runEngine({ store: engineStore, signal: controller.signal, profileLoader: async () => '',
    configLoader: async () => ({ ...(await loadConfig()), gui: { port: 0 }, pollIntervalMs: 250 }),
    client: { unread: async () => {
      if (!queued) {
        queued = true;
        for (const [prompt, epoch] of [['stale', oldEpoch], ['first', oldEpoch + 1], ['second', oldEpoch + 1]])
          engineStore.enqueue('intervention', { prompt, conversationId: 'engine', conversationEpoch: epoch, ceiling });
      }
      if (engineStore.session('engine').turns === 2) controller.abort();
      return [];
    } },
    handle: evaluatePolicy,
    onWake: async (ctx, opts) => {
      assert.equal(opts.handler, 'onIntervention'); assert.notEqual(ctx.prompt, 'stale');
      return evaluatePolicy(ctx, { ...opts, model: { getResponse: async request => {
        calls++; if (calls === 2) resumedHistory = request.input.some(item => item.role === 'assistant');
        return response(ctx.prompt);
      } } });
    } });
  assert.equal(calls, 2); assert(resumedHistory);
  assert.equal(engineStore.session('engine').turns, 2);
  assert(engineStore.records().some(row => row.kind === 'continuation_cancelled'));
  console.log('PASS engine intervention routing, serialized commit/resume and stale-generation cancellation');
} finally { clearTimeout(timeout); controller.abort(); engineStore.close(); }

// Follow-up policies retain their source event without treating it as new intake.
const followups = agentStore(':memory:'), followupStop = new AbortController();
followups.plan('source-run', [{ id: 'parent', kind: 'wake', due: Date.now() + 60000, prompt: 'later', ceiling }], 'source-event');
const seen = [];
const followupTimeout = setTimeout(() => followupStop.abort(), 6000);
let followupsQueued = false;
const followupHandler = async ctx => {
  assert.equal(ctx.messageId, 'source-event');
  const runId = `followup-${ctx.trigger}`;
  followups.record(runId, 'policy_input', { context: ctx });
  seen.push(ctx.trigger);
  return { ok: true, runId, actions: [] };
};
try {
  await runEngine({ store: followups, signal: followupStop.signal, profileLoader: async () => '',
    configLoader: async () => ({ ...(await loadConfig()), gui: { port: 0 }, pollIntervalMs: 250 }),
    client: { unread: async () => {
      if (!followupsQueued) {
        followupsQueued = true;
        followups.enqueue('wake', { actionId: 'parent', prompt: 'follow up', ceiling });
        followups.enqueue('action_result', { outcome: { id: 'parent' } });
      }
      if (seen.length === 2) followupStop.abort();
      return [];
    } }, onWake: followupHandler, onActionResult: followupHandler });
  assert.deepEqual(seen, ['wake', 'action_result']);
  assert.equal(followups.messageRuns('source-event').length, 2);
  console.log('PASS wake and action-result invocations remain linked to their originating event');
} finally { clearTimeout(followupTimeout); followupStop.abort(); followups.close(); }
