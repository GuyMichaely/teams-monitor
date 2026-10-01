import { randomUUID } from 'node:crypto';
import { loadConfig, loadUserProfile } from '../context.mjs';
import { agentStore } from './store.mjs';
import { ensurePolicy, savePolicy, evaluatePolicy } from './policy.mjs';
import { permissionCeiling } from './permissions.mjs';
import { messageContext } from './intake.mjs';
import { validateAction } from './executor.mjs';
import { AgentRuntimeError } from './errors.mjs';

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
  if (path === '/api/agent/policy') {
    if (method === 'GET') return ensurePolicy();
    if (method === 'PUT') return savePolicy(body.source);
  }
  if (path === '/api/agent/status' && method === 'GET') return { mode: store.mode(), current: running ? store.current() : null,
    records: store.records(50).map(presentRecord), actions: store.actions(), conversations: store.conversations() };
  if (path === '/api/agent/mode' && method === 'PUT') return { mode: store.mode(body.mode) };
  if (path === '/api/agent/prompt' && method === 'POST') {
    const contextId = input(body.contextId || 'user', 300), prompt = input(body.prompt);
    const ceiling = permissionCeiling(await loadConfig());
    return { ok: true, ...store.enqueue('prompt', { prompt, contextId, ceiling }) };
  }
  if (path === '/api/agent/wake' && method === 'POST') {
    const cfg = await loadConfig(), id = randomUUID();
    const action = validateAction({ id, kind: 'wake', origin: 'user', prompt: input(body.prompt), contextId: input(body.contextId || 'user', 300),
      due: Date.parse(body.dueAt), ceiling: permissionCeiling(cfg) });
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
