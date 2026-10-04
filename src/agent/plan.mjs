import { randomUUID } from 'node:crypto';
import { isReplyAllowed } from '../reply-policy.mjs';
import { normalizeStatus } from '../teams-presence.mjs';
import { validateAction } from './executor.mjs';
import { AgentRuntimeError, failure } from './errors.mjs';
import { permissions, permissionCeiling, assertPermission } from './permissions.mjs';
import { conversationId } from './conversations.mjs';

export const blankPlan = () => ({ actions: [], cancellations: [], modifications: {}, notes: {}, sessions: {} });
const idOf = handle => typeof handle === 'string' ? handle : handle?.id;
const bad = message => { throw new AgentRuntimeError('INVALID_ACTION', message); };
const alertPayload = payload => {
  if (typeof payload === 'string') return { text: payload };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['chat', 'author', 'text', 'time'].includes(key)) ||
      ['chat', 'author', 'text'].some(key => payload[key] !== undefined && typeof payload[key] !== 'string') ||
      (payload.time !== undefined && payload.time !== null && typeof payload.time !== 'string')) bad('Alert payload accepts only chat, author, text and time.');
  return payload;
};

export function actionAPI({ plan, context, configLoader, store, llm, origin = 'policy', authority, bounded, maxMessages = Infinity }) {
  let messages = 0;
  const add = async value => {
    if (bounded && value.kind === 'wake') value = { ...value, ceiling: permissions(value.ceiling, permissions(bounded, permissionCeiling(await configLoader()))) };
    const action = validateAction({ ...value, due: value.due ?? Date.now() });
    if (action.kind === 'message' && !isReplyAllowed(await configLoader(), action.chat)) throw new AgentRuntimeError('DENIED', 'Current reply policy blocks this chat.');
    if (action.kind === 'message' && messages >= maxMessages) throw new AgentRuntimeError('MESSAGE_LIMIT', 'Outgoing message limit reached.');
    const key = a => JSON.stringify([a.kind, a.chat, a.text, a.presence, a.kind === 'wake' ? a : null, a.due > Date.now() + 1000 ? a.due : 0]);
    const same = plan.actions.find(a => !a.cancelled && key(a) === key(action));
    if (same) return { ok: true, id: same.id, state: 'pending' };
    if (plan.actions.length >= 100) throw new AgentRuntimeError('ACTION_LIMIT', 'Handler action limit reached.');
    const id = randomUUID();
    plan.actions.push({ ...action, id, origin, ...((authority || bounded) ? { authority: authority || bounded } : {}) });
    if (action.kind === 'message') messages++;
    return { ok: true, id, state: 'pending' };
  };
  const expected = (fn, method) => async (...args) => {
    try {
      if (bounded && method !== 'llm') {
        const p = permissions(bounded, permissionCeiling(await configLoader()));
        const capability = { readReactions: 'read_reactions', sendMessage: 'send_message', alert: 'alert', setStatus: 'set_status', delay: 'schedule', wake: 'schedule', cancel: 'cancel_action', modify: 'modify_action' }[method];
        const own = plan.actions.some(action => action.id === idOf(args[0]));
        if (own && ['cancel', 'modify'].includes(method)) {
          if (!p.tools.includes(capability)) throw new AgentRuntimeError('DENIED', 'Saved wake permissions block this action.');
        } else assertPermission(p, capability, ['sendMessage', 'readReactions'].includes(method) ? args[0] : null, idOf(args[0]), method === 'modify' ? 'text' : undefined);
        const kind = { sendMessage: 'message', alert: 'alert', setStatus: 'status', wake: 'wake' }[method];
        if (kind && !p.initiateActions.includes(kind)) throw new AgentRuntimeError('DENIED', 'Saved wake permissions block this action.');
      }
      return await fn(...args);
    } catch (error) { return failure(error); }
  };
  const api = {
    readReactions: expected((chat, messageId) => store.reactions(chat, messageId), 'readReactions'),
    sendMessage: expected((chat, text) => add({ kind: 'message', chat, text }), 'sendMessage'),
    alert: expected((payload = {}) => add({ kind: 'alert', chat: context.chatName || 'TM', author: context.authorName || 'TM', text: context.message?.text || 'Attention requested', time: context.now, ...alertPayload(payload) }), 'alert'),
    setStatus: expected(presence => add({ kind: 'status', presence: normalizeStatus(presence) }), 'setStatus'),
    delay: expected((handle, time) => {
      const action = plan.actions.find(a => a.id === idOf(handle));
      if (!action || action.cancelled) bad('Delay requires a pending proposal from this handler.');
      const due = typeof time === 'string' ? Date.parse(time) : time?.afterMs !== undefined ? Date.now() + time.afterMs : time;
      validateAction({ ...action, due });
      if (due <= Date.now()) bad('Choose a future time.');
      action.due = due;
      return { ok: true, id: action.id, state: 'pending', dueAt: new Date(due).toISOString() };
    }, 'delay'),
    cancel: expected(handle => {
      const id = idOf(handle), action = plan.actions.find(a => a.id === id);
      if (action) { action.cancelled = true; return { ok: true, id, state: 'cancelled' }; }
      if (store.action(id)?.state !== 'pending') bad('Action is not pending.');
      delete plan.modifications[id];
      if (!plan.cancellations.includes(id)) plan.cancellations.push(id);
      return { ok: true, id, state: 'cancelled' };
    }, 'cancel'),
    modify: expected((handle, changes) => {
      const id = idOf(handle), local = plan.actions.find(a => a.id === id), stored = local ? null : store.action(id);
      const action = local || (stored?.state === 'pending' ? stored.value : null);
      if (!action || action.cancelled || plan.cancellations.includes(id) || !changes || !['alert', 'message'].includes(action.kind) || Object.keys(changes).some(key => key !== 'text')) bad('Only pending proposal text can be modified.');
      validateAction({ ...action, ...changes }); Object.assign(action, changes);
      if (bounded && stored) action.review = { authority: bounded, field: 'text' };
      if (stored) plan.modifications[id] = { expectedBody: plan.modifications[id]?.expectedBody || stored.body, action };
      return { ok: true, id, state: 'pending' };
    }, 'modify'),
    wake: expected((prompt, options = {}) => {
      if (Object.hasOwn(options, 'contextId')) bad('Use conversationId for explicit history continuation.');
      const id = conversationId(options.conversationId);
      return add({ kind: 'wake', prompt, conversationId: id, conversationEpoch: id ? store.session(id).epoch : undefined,
        due: Date.parse(options.dueAt), ceiling: options.permissions || authority || bounded });
    }, 'wake'),
    llm: expected((prompt, options) => llm(prompt, options), 'llm'),
  };
  return { api, add };
}
