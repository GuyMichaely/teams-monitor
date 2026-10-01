import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Usage } from '@openai/agents';
import { agentStore } from '../src/agent/store.mjs';
import { evaluatePolicy, savePolicy } from '../src/agent/policy.mjs';
import { executeAction } from '../src/agent/executor.mjs';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { DATA_DIR } from '../src/local-paths.mjs';
import { blankPlan, actionAPI } from '../src/agent/plan.mjs';
import { permissionCeiling } from '../src/agent/permissions.mjs';

const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const response = output => ({ output, usage: new Usage({ requests: 1 }) });
const call = (name, args, callId = 'test') => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });
const fixtureModel = sequence => { let turn = 0; return { getResponse: async request => sequence(++turn, request) }; };
const context = { trigger: 'message', contextId: 'chat:Alice', chatName: 'Alice', authorName: 'Alice', message: { author: 'Alice', text: 'Fixture' } };
const config = await loadConfig(); config.replyPolicy = { mode: 'whitelist', entries: ['Alice'] }; await saveConfig(config);
const file = join(DATA_DIR, 'agent', 'continuity.sqlite');
let store = agentStore(file);
try {
  await savePolicy(`export async function handle(ctx,a) {
    await a.alert('deterministic');
    return a.llm('keep notes', {tools:['write_note','read_note'],readChats:['Alice'],contextId:ctx.contextId});
  }`);
  const first = await evaluatePolicy(context, { store, model: fixtureModel(turn => response(turn === 1 ? [call('write_note', { path: 'projects/demo.md', text: 'Remember this fixture' })] : [message('Recorded')])) });
  assert.equal(first.ok, true); assert.equal(store.note('projects/demo.md').text, '');
  store.commit(first.runId, first);
  assert.equal(store.note('projects/demo.md').text, 'Remember this fixture');
  assert.equal(await readFile(join(DATA_DIR, 'agent', 'notes', 'projects', 'demo.md'), 'utf8'), 'Remember this fixture');
  assert(store.session('chat:Alice').history.length >= 3);
  store.close(); store = agentStore(file);
  assert.equal(store.note('projects/demo.md').text, 'Remember this fixture');
  assert(store.session('chat:Alice').history.length >= 3);
  let continued = false;
  const second = await evaluatePolicy(context, { store, model: fixtureModel((turn, request) => {
    continued = request.input.some(item => item.type === 'message' && item.role === 'assistant');
    return response([message('Continuing same session')]);
  }) });
  assert.equal(second.ok, true); assert(continued, 'SDK history survives restart');
  const failed = await evaluatePolicy(context, { store, model: fixtureModel(turn => {
    if (turn === 1) return response([call('write_note', { path: 'projects/demo.md', text: 'Must not persist' })]);
    throw Error('provider failed');
  }) });
  assert.equal(failed.ok, true); assert.equal(failed.value.ok, false);
  assert.equal(failed.notes['projects/demo.md'], undefined);
  assert.equal(store.note('projects/demo.md').text, 'Remember this fixture');

  // A true later handler fault also discards successful model note edits.
  await savePolicy(`export async function handle(ctx,a) { await a.llm('write', {tools:['write_note'],readChats:['Alice']}); throw Error('fault'); }`);
  const fault = await evaluatePolicy(context, { store, model: fixtureModel(turn => response(turn === 1 ? [call('write_note', { path: 'discard.md', text: 'discard' })] : [message('done')])) });
  assert.equal(fault.ok, false); assert.equal(store.note('discard.md').text, '');

  // Expected read-only/paused errors never disable deterministic alerts.
  await savePolicy(`export async function handle(ctx,a) { await a.alert('always'); return a.llm('write', {tools:['write_note'],readChats:['Alice']}); }`);
  store.mode('read_only');
  const readonly = await evaluatePolicy(context, { store, model: fixtureModel(turn => response(turn === 1 ? [call('write_note', { path: 'denied.md', text: 'deny' })] : [message('handled denial')])) });
  assert.equal(readonly.ok, true); assert.equal(readonly.actions.length, 1); assert.deepEqual(readonly.notes, {});
  store.mode('paused');
  let called = false;
  const paused = await evaluatePolicy(context, { store, model: { getResponse: async () => { called = true; return response([message('wrong')]); } } });
  assert.equal(paused.value.error.code, 'PAUSED'); assert.equal(called, false); assert.equal(paused.actions.length, 1);
  store.mode('active');

  // Stored pending text edits are guarded against an execution/cancellation race.
  store.plan('seed', [{ id: 'editable', kind: 'alert', chat: 'Alice', text: 'old', due: Date.now() + 60000 }]);
  const plan = blankPlan(), api = actionAPI({ plan, context, store, configLoader: loadConfig }).api;
  assert.equal((await api.modify('editable', { text: 'new' })).ok, true);
  assert.equal(store.action('editable').value.text, 'old');
  store.commit('edit', plan); assert.equal(store.action('editable').value.text, 'new');
  const conflict = blankPlan(), stale = actionAPI({ plan: conflict, context, store, configLoader: loadConfig }).api;
  await stale.modify('editable', { text: 'stale' }); store.cancel('editable');
  assert.throws(() => store.commit('conflict', conflict), /changed|execution/);
  assert.equal(store.action('editable').value.text, 'new');
} finally { store.close(); }

const jobs = agentStore(':memory:');
try {
  const past = Date.now() - 60000;
  const ceiling = permissionCeiling(config);
  jobs.plan('seed', [{ id: 'old-alert', kind: 'alert', chat: 'Alice', text: 'missed', due: past },
    { id: 'overdue-wake', kind: 'wake', prompt: 'reassess', contextId: 'saved', ceiling, due: past }]);
  jobs.recover(new Date().toISOString());
  assert.equal(jobs.action('old-alert').state, 'missed'); assert.equal(jobs.action('overdue-wake').state, 'pending');
  let wakeCount = 0;
  const outcome = await executeAction({ store: jobs, client: {}, loadConfig, wake: async action => {
    wakeCount++; assert(action.latenessMs >= 60000); return { ok: true, ...jobs.enqueue('wake', action) };
  } });
  assert.equal(outcome.state, 'completed'); assert.equal(wakeCount, 1);
  assert.equal(await executeAction({ store: jobs, client: {}, loadConfig }), null);
  const wake = jobs.claimWork(); assert.equal(wake.value.contextId, 'saved');
  await savePolicy(`export async function handle() {} export async function onWake(ctx,a) {
    return a.llm('cannot expand authority', {tools:['alert'],readChats:['*'],initiateActions:['alert']});
  }`);
  const narrow = { ...ceiling, tools: ['alert'], readChats: ['Alice'], initiateActions: [] };
  let wakeModelCalls = 0;
  const result = await evaluatePolicy({ ...wake.value, trigger: 'wake' }, { store: jobs, handler: 'onWake', savedCeiling: narrow,
    model: fixtureModel(turn => { wakeModelCalls++; return response(turn === 1 ? [call('alert', { text: 'not allowed' })] : [message('handled denial')]); }) });
  assert.equal(wakeModelCalls, 2, 'saved ceiling bounds the model tools, not access to llm itself');
  assert.equal(result.ok, true); assert.equal(result.actions.length, 0, 'wake cannot acquire a capability missing from its saved ceiling');
  await savePolicy('export async function handle() {}');
  const defaultWake = await evaluatePolicy({ trigger: 'prompt', prompt: 'default onWake', contextId: 'direct', ceiling }, { store: jobs, handler: 'onWake', savedCeiling: ceiling,
    model: fixtureModel(() => response([message('direct prompt response')])) });
  assert.equal(defaultWake.ok, true); assert.equal(defaultWake.value.output, 'direct prompt response', 'direct prompts work without a custom onWake export');
  await savePolicy(`export async function handle() {} export async function onWake(ctx,a) { return a.alert('direct hook proposal'); }`);
  const direct = await evaluatePolicy({ ...wake.value, trigger: 'wake' }, { store: jobs, handler: 'onWake', savedCeiling: narrow });
  assert.equal(direct.ok, true); assert.equal(direct.value.error.code, 'DENIED'); assert.equal(direct.actions.length, 0, 'wake hook cannot bypass its saved ceiling by using deterministic functions');
  const permitted = await evaluatePolicy({ ...wake.value, trigger: 'wake' }, { store: jobs, handler: 'onWake', savedCeiling: { ...narrow, initiateActions: ['alert'] } });
  assert.equal(permitted.value.ok, true); assert.equal(permitted.actions.length, 1); assert(permitted.actions[0].authority, 'wake proposals preserve authority for delayed execution');

  jobs.plan('seed', [{ id: 'interrupted', kind: 'alert', chat: 'Alice', text: 'uncertain' }]);
  assert.equal(jobs.claimAction().id, 'interrupted');
  jobs.recover(new Date().toISOString()); assert.equal(jobs.action('interrupted').state, 'uncertain');
  const p = { ...ceiling, tools: ['alert'], initiateActions: ['alert'] };
  jobs.plan('seed', [{ id: 'revoked', kind: 'alert', origin: 'agent', authority: p, chat: 'Alice', text: 'blocked' }]);
  jobs.mode('read_only');
  let alerts = 0;
  assert.equal((await executeAction({ store: jobs, client: {}, loadConfig, alert: async () => { alerts++; } })).state, 'blocked');
  assert.equal(alerts, 0);
} finally { jobs.close(); }
console.log('PASS durable notes/sessions, staged rollback, autonomy, pending edits, overdue wake ceiling, and uncertain no-retry');
