import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { Usage } from '@openai/agents';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { agentStore } from '../src/agent/store.mjs';
import { convertAutomationToPolicy } from './lib/convert-policy.mjs';
import { evaluatePolicy, savePolicy, POLICY_FILE } from '../src/agent/policy.mjs';
import { executeAction } from '../src/agent/executor.mjs';
import { AgentRuntimeError } from '../src/agent/errors.mjs';

const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const call = (name, args, callId) => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });
const response = output => ({ output, usage: new Usage({ requests: 1 }) });
const textValues = (value, into = []) => {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach(item => textValues(item, into));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => textValues(item, into));
  return into;
};
function policyPayload(input) {
  for (const text of textValues(input)) {
    try {
      const value = JSON.parse(text);
      if (value && Array.isArray(value.proposals) && value.permissions?.cancelIds) return value;
    } catch {}
  }
  throw new Error('SDK input did not include the policy permission payload');
}
function outputFor(request, id) {
  const item = request.input.find(value => value.type === 'function_call_result' && value.callId === id);
  assert(item, `missing tool result for ${id}`);
  const value = item.output?.type === 'text' ? item.output.text : item.output;
  return typeof value === 'string' ? JSON.parse(value) : value;
}
const event = { trigger: 'message', contextId: 'chat:alex', chatName: 'Alex', authorName: 'Alex',
  message: { id: 'rule-message', author: 'Alex', text: '@Guy please review 1234', mentions: ['Guy'], time: new Date().toISOString() },
  isDM: true, mentionsMe: true, history: [], mentionNames: ['Guy'], now: new Date().toISOString() };
const automation = { rules: [
  { id: 'mention-phone', when: { type: 'mention' }, action: { type: 'alert_phone' } },
  { id: 'direct-phone', when: { type: 'direct_message' }, action: { type: 'alert_phone' } },
  { id: 'deterministic-reply', when: { field: 'text', match: 'contains_number', value: '1234' }, action: { type: 'reply', text: 'Original deterministic reply' }, agent: { cancel: true, modify: true } },
], agent: { initiate: { when: 'always', actions: ['reply'] }, timeoutMs: 1000 } };

let config = await loadConfig();
config.replyPolicy = { mode: 'whitelist', entries: ['Alex'] };
config.alerts = { ...(config.alerts || {}), mentionNames: ['Guy'], ignoreAuthors: [] };
config.agent = { ...(config.agent || {}), timeoutMs: 5000, policyTimeoutMs: 1000, maxTurns: 6, maxMessages: 3 };
await saveConfig(config);
const source = convertAutomationToPolicy(automation, config.alerts);
await savePolicy(source, POLICY_FILE);

// Provider failure is returned to JavaScript policy; configured reply and phone
// proposals survive, and default alert rules have no cancellation/modification authority.
{
  const store = agentStore(':memory:');
  try {
    const failingModel = { async getResponse() { throw new AgentRuntimeError('PROVIDER_ERROR', 'Mock model unavailable.'); } };
    const result = await evaluatePolicy(event, { store, model: failingModel });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.evaluations.every(item => item.matched), true);
    assert.equal(result.actions.some(action => action.kind === 'message' && action.text === 'Original deterministic reply'), true);
    assert.equal(result.actions.filter(action => action.kind === 'alert').length, 1, 'identical mention/DM phone proposals deduplicate');
    assert(result.actions.filter(action => action.kind === 'alert').every(action => typeof action.title === 'string' && typeof action.body === 'string' && !('chat' in action) && !('text' in action) && !('author' in action)), 'planned phone actions contain title/body only');
    assert.equal(result.value.proposals.find(item => item.action.type === 'alert_phone').permissions.cancel, false);
    assert.equal(result.value.proposals.find(item => item.action.type === 'alert_phone').permissions.modify, false);
    assert.deepEqual(result.value.review.error, { code: 'PROVIDER_ERROR', message: 'Mock model unavailable.' });
  } finally { store.close(); }
}

// A model tries to cancel the deduplicated default phone alert. The SDK tool rejects
// that ID, the model handles the denial, and its final prose is never sent as a reply.
let successfulActions;
{
  const store = agentStore(':memory:');
  try {
    let turn = 0, alertId, requestTools;
    const mockModel = { async getResponse(request) {
      turn++;
      if (turn === 1) {
        const payload = policyPayload(request.input);
        const phone = payload.proposals.find(item => item.kind === 'alert');
        const reply = payload.proposals.find(item => item.kind === 'message');
        assert(phone && reply);
        alertId = phone.id;
        assert.equal(payload.permissions.cancelIds.includes(alertId), false, 'default phone action is outside rule cancellation authority');
        assert.equal(payload.permissions.modifyIds[alertId], undefined, 'default phone action is outside rule modification authority');
        assert.equal(payload.permissions.cancelIds.includes(reply.id), true, 'only the explicitly permitted deterministic reply is cancellable');
        requestTools = request.tools.map(tool => tool.name);
        return response([call('cancel_action', { id: alertId }, 'try-cancel-default-phone')]);
      }
      assert.equal(outputFor(request, 'try-cancel-default-phone').error.code, 'DENIED');
      return response([message('I reviewed it. This text is not an implicit Teams message.')]);
    } };
    const result = await evaluatePolicy(event, { store, model: mockModel });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(turn, 2, 'model receives and recovers from the permission denial');
    assert(requestTools.includes('cancel_action'));
    assert(requestTools.includes('modify_action'));
    assert.equal(result.value.review.output, 'I reviewed it. This text is not an implicit Teams message.');
    assert.deepEqual(result.cancellations, []);
    assert.equal(result.actions.some(action => action.kind === 'alert' && action.id === alertId), true);
    assert.equal(result.actions.some(action => action.kind === 'message' && action.text === 'Original deterministic reply'), true);
    successfulActions = structuredClone(result.actions);
  } finally { store.close(); }
}

// With global reply permission revoked, the message proposal is denied while the
// configured phone action remains available and independent.
{
  const emptyReplyConfig = { ...config, replyPolicy: { mode: 'whitelist', entries: [] } };
  const noInitiate = { ...automation, agent: { initiate: { when: 'never', actions: [] }, timeoutMs: 1000 } };
  await savePolicy(convertAutomationToPolicy(noInitiate, config.alerts), POLICY_FILE);
  const store = agentStore(':memory:');
  try {
    const result = await evaluatePolicy(event, { store, configLoader: async () => emptyReplyConfig });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.proposals.find(item => item.action.type === 'reply').result.error.code, 'DENIED');
    assert.deepEqual(result.actions.map(action => action.kind), ['alert']);
  } finally { store.close(); }
}

async function runCommitted(actions, loadConfig, { alert, send } = {}) {
  const store = agentStore(':memory:');
  try {
    store.commit('committed-fixture', { actions: structuredClone(actions), cancellations: [], notes: {}, sessions: {} });
    const outcomes = [];
    for (let i = 0; i < actions.length + 1; i++) {
      const outcome = await executeAction({ store, loadConfig, alert, client: { async send(chat, text) { send?.(chat, text); return { result: 'sent' }; } } });
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return { outcomes, store };
  } catch (error) { store.close(); throw error; }
}

// Execution uses current reply permission. Revoking it blocks only the Teams send;
// the phone alert still executes. A phone transport failure likewise does not stop
// an independently queued, allowed Teams reply.
{
  const sent = [], phone = [];
  const denied = await runCommitted(successfulActions, async () => ({ ...config, replyPolicy: { mode: 'whitelist', entries: [] } }), {
    alert: async action => { phone.push(action); return { sent: true }; },
    send: (chat, text) => sent.push({ chat, text }),
  });
  assert.equal(sent.length, 0, 'latest reply policy is checked again at execution');
  assert.equal(phone.length, 1, 'reply denial does not suppress phone alert delivery');
  assert.equal(denied.outcomes.find(outcome => outcome.action.kind === 'message').state, 'blocked');
  assert.equal(denied.outcomes.find(outcome => outcome.action.kind === 'alert').state, 'completed');
  denied.store.close();

  const sentAfterPhoneFailure = [];
  const phoneFailure = await runCommitted(successfulActions, async () => config, {
    alert: async () => { throw new Error('mock phone transport failure'); },
    send: (chat, text) => sentAfterPhoneFailure.push({ chat, text }),
  });
  assert.equal(sentAfterPhoneFailure.length, 1, 'phone failure does not prevent a permitted deterministic reply');
  assert.equal(phoneFailure.outcomes.find(outcome => outcome.action.kind === 'alert').state, 'uncertain');
  assert.equal(phoneFailure.outcomes.find(outcome => outcome.action.kind === 'message').state, 'completed');
  phoneFailure.store.close();
}

console.log('Agent rule execution smoke passed: conversion, deterministic proposals, default-action authority, provider recovery, and independent execution outcomes.');
