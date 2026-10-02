import { randomUUID } from 'node:crypto';
import { loadConfig, loadUserProfile, saveConfig } from '../context.mjs';
import { parseConfigYaml, configYaml } from '../config-format.mjs';
import { agentStore } from './store.mjs';
import { ensurePolicy, savePolicy, evaluatePolicy } from './policy.mjs';
import { permissionCeiling, permissions } from './permissions.mjs';
import { messageContext } from './intake.mjs';
import { validateAction } from './executor.mjs';
import { AgentRuntimeError } from './errors.mjs';
import { conversationId } from './conversations.mjs';

const input = (value, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AgentRuntimeError('INVALID_INPUT', 'Invalid or oversized input.');
  return value;
};
const presentRecord = row => {
  let value = row.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { seq: row.seq, at: row.at, kind: 'invalid_log', value: { error: 'Invalid log format', originalKind: row.kind } };
  if (row.kind === 'agent_result') { const { history, ...result } = value; value = result; }
  if (row.kind === 'policy_input') value = { handler: value.handler, version: value.version, trigger: value.context?.trigger, messageId: value.context?.messageId };
  if (JSON.stringify(value).length > 16000) value = { excerpt: JSON.stringify(value).slice(0, 16000), truncated: true, recordId: row.seq };
  return { seq: row.seq, at: row.at, kind: row.kind, value };
};

export async function agentAPI({ url, method, body, store, running = false }) {
  const path = url.pathname;
  if (path === '/api/agent/permissions') {
    if (method === 'GET') return { source: configYaml(permissionCeiling(await loadConfig())) };
    if (method === 'PUT') {
      let ceiling;
      try {
        const value = parseConfigYaml(input(body.source, 64000));
        const fields = ['tools', 'readChats', 'writeChats', 'initiateActions', 'cancelIds', 'modifyIds'];
        // Complete, explicit saves prevent an omitted/null field restoring broad defaults.
        if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key)) ||
            fields.slice(0, -1).some(key => !Array.isArray(value[key])) ||
            !value.modifyIds || typeof value.modifyIds !== 'object' || Array.isArray(value.modifyIds)) throw Error();
        ceiling = permissionCeiling({ agent: { ceiling: value } });
        permissions(ceiling, ceiling);
      } catch {
        throw new AgentRuntimeError('INVALID_PERMISSIONS', 'Invalid permissions YAML. Keep all six fields; use lists for tools, readChats, writeChats, initiateActions and cancelIds, and an ID-to-[text] mapping for modifyIds.');
      }
      const config = await loadConfig();
      config.agent = { ...config.agent, ceiling };
      await saveConfig(config);
      return { source: configYaml(ceiling) };
    }
  }
  if (path === '/api/agent/policy') {
    if (method === 'GET') return ensurePolicy();
    if (method === 'PUT') return savePolicy(body.source);
  }
  if (path === '/api/agent/status' && method === 'GET') {
    const active = running ? store.current() : null;
    const modelConversations = store.sessions().map(s => ({ ...s, canIntervene: active?.conversationId === s.id || (!s.invalid && !!store.session(s.id).permissions) }));
    if (active?.conversationId && !modelConversations.some(s => s.id === active.conversationId))
      modelConversations.unshift({ id: active.conversationId, turns: 0, canIntervene: true, active: true });
    return { mode: store.mode(), current: active ? { runId: active.runId, trigger: active.trigger, conversationId: active.conversationId, startedAt: active.startedAt } : null,
      records: store.records(50).map(presentRecord), actions: store.actions(), conversations: store.conversations(), modelConversations };
  }
  if (path === '/api/agent/mode' && method === 'PUT') return { mode: store.mode(body.mode) };
  if (path === '/api/agent/conversation' && method === 'GET') {
    const id = conversationId(input(url.searchParams.get('id'), 300)), s = store.session(id);
    if (!s.exists) throw new AgentRuntimeError('NOT_FOUND', 'Conversation has no committed history yet.');
    const bound = value => !value || typeof value !== 'object' ? { error: 'Invalid log format' } :
      JSON.stringify(value).length > 100000 ? { excerpt: JSON.stringify(value).slice(0, 100000), truncated: true } : value;
    return { id, ...bound(s), archives: store.sessionArchives(id).map(row => ({ recordId: row.seq, at: row.at, ...bound(row.value.previous) })) };
  }
  if (path === '/api/agent/conversation/reset' && method === 'POST') {
    const id = conversationId(input(body.conversationId, 300));
    const reset = store.resetSession(id);
    const active = running ? store.current() : null;
    if (active?.conversationId === id) store.cancelRun(active.runId);
    return { ok: true, ...reset };
  }
  if (path === '/api/agent/intervene' && method === 'POST') {
    const id = conversationId(input(body.conversationId, 300)), prompt = input(body.prompt), s = store.session(id);
    const active = running && store.current()?.conversationId === id ? store.current() : null;
    const granted = active?.permissions || (!s.invalid && s.permissions);
    if (!granted) throw new AgentRuntimeError('NOT_FOUND', 'Select an existing conversation with granted permissions.');
    const ceiling = permissions(granted, permissionCeiling(await loadConfig()));
    const queued = store.enqueue('intervention', { prompt, conversationId: id, conversationEpoch: active?.conversationEpoch ?? s.epoch, ceiling, chatName: s.chatName });
    store.record(queued.id, 'intervention_queued', { conversationId: id, prompt, ceiling });
    return { ok: true, ...queued };
  }
  if (path === '/api/agent/run/cancel' && method === 'POST') {
    if (!running) throw new AgentRuntimeError('NOT_ACTIVE', 'No active orchestrator run.');
    const id = input(body.runId, 100); store.cancelRun(id);
    return { ok: true, runId: id };
  }
  if (path === '/api/agent/wake' && method === 'POST') {
    if (Object.hasOwn(body, 'contextId')) throw new AgentRuntimeError('INVALID_INPUT', 'Use conversationId for explicit history continuation.');
    const cfg = await loadConfig(), id = randomUUID();
    const key = conversationId(body.conversationId), s = key ? store.session(key) : null;
    const action = validateAction({ id, kind: 'wake', origin: 'user', prompt: input(body.prompt), conversationId: key,
      conversationEpoch: s?.epoch, due: Date.parse(body.dueAt), ceiling: s?.permissions ? permissions(s.permissions, permissionCeiling(cfg)) : permissionCeiling(cfg) });
    if (action.due <= Date.now()) throw new AgentRuntimeError('INVALID_INPUT', 'Choose a future wake time.');
    store.plan('manual:' + id, [action]); return { ok: true, id, state: 'pending' };
  }
  if (/^\/api\/agent\/actions\/[^/]+\/cancel$/.test(path) && method === 'POST') {
    const id = path.split('/')[4];
    if (!store.cancel(id)) throw new AgentRuntimeError('NOT_PENDING', 'Action is no longer pending.');
    store.record('manual', 'action_cancelled', { id }); return { ok: true, id, state: 'cancelled' };
  }
  if (path === '/api/agent/notes' && method === 'GET') return { notes: store.notes().map(n => ({ path: n.path })) };
  if (path === '/api/agent/note') {
    if (method === 'GET') return store.note(url.searchParams.get('path'));
    if (method === 'PUT') { const note = store.note(body.path, body.text); store.mirrorNotes(); return note; }
  }
  if (path === '/api/agent/brief') {
    if (method === 'GET') return store.brief(url.searchParams.get('chat'));
    if (method === 'PUT') return store.brief(body.chat, body.text);
  }
  if (path === '/api/agent/replay' && method === 'POST') {
    const row = store.message(input(body.messageId, 128));
    if (!row?.value) throw new AgentRuntimeError('NOT_FOUND', 'Recorded message not found or invalid.');
    const cfg = await loadConfig(), profile = await loadUserProfile(), replay = agentStore(':memory:');
    try {
      for (const note of store.notes()) replay.note(note.path, note.text);
      const context = messageContext(row, store, cfg, profile); context.brief = store.brief(row.chat).text;
      const result = await evaluatePolicy(context, { store: replay, replay: true });
      store.record(result.runId, 'replay', { messageId: row.id, result });
      return { ...result, externalActionsDisabled: true, modelDisabled: true };
    } finally { replay.close(); }
  }
  throw new AgentRuntimeError('NOT_FOUND', 'Unknown agent endpoint or method.');
}
