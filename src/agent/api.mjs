import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadUserProfile, saveConfig } from '../context.mjs';
import { parseConfigYaml, configYaml } from '../config-format.mjs';
import { agentStore } from './store.mjs';
import { ensurePolicy, savePolicy, evaluatePolicy, POLICY_FILE } from './policy.mjs';
import { permissionCeiling, permissions } from './permissions.mjs';
import { messageContext } from './intake.mjs';
import { validateAction } from './executor.mjs';
import { AgentRuntimeError } from './errors.mjs';
import { conversationId } from './conversations.mjs';
import { sandboxStatus } from './sandbox.mjs';
import { sandboxLimits } from './sandbox-limits.mjs';
import { messageInvocations } from './invocations.mjs';
import { validateChatMembers, validatePersonName, validatePersonNote } from './person-notes.mjs';

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
export const presentAction = row => {
  let result = null;
  if (row.result != null) { try { result = JSON.parse(row.result); } catch { result = { error: 'Invalid log format' }; } }
  const { body, ...fields } = row;
  return { ...fields, result };
};

export async function agentAPI({ url, method, body, store, running = false }) {
  const path = url.pathname;
  if (path === '/api/agent/permissions') {
    if (method === 'GET') { const { sandbox, ...ceiling } = permissionCeiling(await loadConfig()); return { source: configYaml(ceiling) }; }
    if (method === 'PUT') {
      let ceiling;
      try {
        const value = parseConfigYaml(input(body.source, 64000));
        const fields = ['tools', 'readChats', 'writeChats', 'initiateActions', 'cancelIds', 'modifyIds'];
        // Complete, explicit saves prevent an omitted/null field restoring broad defaults.
        if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key)) ||
            fields.slice(0, -1).some(key => !Array.isArray(value[key])) ||
            !value.modifyIds || typeof value.modifyIds !== 'object' || Array.isArray(value.modifyIds)) throw Error();
        const { sandbox, ...parsed } = permissionCeiling({ agent: { ceiling: value } });
        ceiling = parsed;
        permissions(ceiling, permissionCeiling({ agent: { ceiling } }));
      } catch {
        throw new AgentRuntimeError('INVALID_PERMISSIONS', 'Invalid permissions YAML. Keep all six fields; use lists for tools, readChats, writeChats, initiateActions and cancelIds. modifyIds maps IDs to editable fields: text for Teams messages, title/body for notifications.');
      }
      const config = await loadConfig();
      config.agent = { ...config.agent, ceiling };
      await saveConfig(config);
      return { source: configYaml(ceiling) };
    }
  }
  if (path === '/api/agent/sandbox') {
    if (method === 'GET') return { ...sandboxStatus(), source: configYaml(sandboxLimits((await loadConfig()).agent?.sandbox)) };
    if (method === 'PUT') {
      const settings = sandboxLimits(parseConfigYaml(input(body.source, 4000)));
      const config = await loadConfig(); config.agent = { ...config.agent, sandbox: settings }; await saveConfig(config);
      return { ...sandboxStatus(), source: configYaml(settings) };
    }
  }
  if (path === '/api/agent/policy') {
    if (method === 'GET' || method === 'PUT') {
      const policy = method === 'GET' ? await ensurePolicy() : await savePolicy(body.source);
      // HTTP pages cannot navigate to file:// resources; use the local editor's
      // file protocol without asking the server to execute a .mjs association.
      return { ...policy, path: POLICY_FILE, editorUrl: 'vscode://file' + pathToFileURL(POLICY_FILE).pathname };
    }
  }
  if (path === '/api/agent/status' && method === 'GET') {
    const active = running ? store.current() : null;
    const modelConversations = store.sessions().map(s => ({ ...s, canIntervene: active?.conversationId === s.id || (!s.invalid && !!store.session(s.id).permissions) }));
    if (active?.conversationId && !modelConversations.some(s => s.id === active.conversationId))
      modelConversations.unshift({ id: active.conversationId, turns: 0, canIntervene: true, active: true });
    return { mode: store.mode(), current: active ? { runId: active.runId, trigger: active.trigger, conversationId: active.conversationId, startedAt: active.startedAt } : null,
      records: store.records(50).map(presentRecord), actions: store.actions().map(presentAction), conversations: store.conversations(), modelConversations };
  }
  if (path === '/api/agent/mode' && method === 'PUT') return { mode: store.mode(body.mode) };
  if (path === '/api/agent/invocations' && method === 'GET') {
    const id = input(url.searchParams.get('messageId'), 128);
    return { ...messageInvocations(store, id, running ? store.current() : null), actions: store.messageActions(id).map(presentAction) };
  }
  if (path === '/api/agent/conversation' && method === 'GET') {
    const id = conversationId(input(url.searchParams.get('id'), 300)), s = store.session(id);
    if (!s.exists) throw new AgentRuntimeError('NOT_FOUND', 'Conversation has no committed history yet.');
    const bound = value => !value || typeof value !== 'object' ? { error: 'Invalid log format' } :
      JSON.stringify(value).length > 100000 ? { excerpt: JSON.stringify(value).slice(0, 100000), truncated: true } : value;
    return { id, ...bound(s), archives: store.sessionArchives(id).map(row => ({ recordId: row.seq, at: row.at, ...bound(row.value?.previous) })) };
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
    const queued = store.enqueue('intervention', { prompt, conversationId: id, conversationEpoch: active?.conversationEpoch ?? s.epoch, ceiling, chatName: active?.chatName || s.chatName, authorName: active?.authorName || s.authorName, messageId: active?.messageId || s.messageId });
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
      conversationEpoch: s?.epoch, chatName: s?.chatName, authorName: s?.authorName,
      due: Date.parse(body.dueAt), ceiling: s?.permissions ? permissions(s.permissions, permissionCeiling(cfg)) : permissionCeiling(cfg) });
    if (action.due <= Date.now()) throw new AgentRuntimeError('INVALID_INPUT', 'Choose a future wake time.');
    store.plan('manual:' + id, [action]); return { ok: true, id, state: 'pending' };
  }
  if (/^\/api\/agent\/actions\/[^/]+\/cancel$/.test(path) && method === 'POST') {
    const id = path.split('/')[4];
    if (!store.cancel(id)) throw new AgentRuntimeError('NOT_PENDING', 'Action is no longer pending.');
    store.record('manual', 'action_cancelled', { id }); return { ok: true, id, state: 'cancelled' };
  }
  if (path === '/api/agent/notes' && method === 'GET') return { notes: store.notes().map(n => ({ path: n.path })) };
  if (path === '/api/agent/person-notes') {
    if (method === 'GET') {
      if (url.searchParams.has('name')) return store.personNote(validatePersonName(url.searchParams.get('name')));
      return { people: store.personNotes(), memberships: store.chatMemberships() };
    }
    if (method === 'PUT') {
      const name = validatePersonName(body.name), note = validatePersonNote(body.note);
      return store.personNote(name, note);
    }
    if (method === 'DELETE') {
      const name = validatePersonName(url.searchParams.get('name'));
      store.personNote(name, '');
      return { ok: true, name };
    }
  }
  if (path === '/api/agent/chat-members') {
    if (method === 'GET') return store.chatMembers(input(url.searchParams.get('chat'), 300));
    if (method === 'PUT') {
      const { chat, members } = validateChatMembers(body.chat, body.members);
      return store.chatMembers(chat, members);
    }
  }
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
