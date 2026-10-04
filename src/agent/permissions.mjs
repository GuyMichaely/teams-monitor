import { normalize } from './store.mjs';
import { AgentRuntimeError } from './errors.mjs';
import { sandboxLimits } from './sandbox-limits.mjs';

export const TOOL_NAMES = ['list_conversations', 'read_conversation', 'read_reactions', 'search_conversations', 'send_message', 'alert', 'set_status', 'schedule', 'cancel_action', 'modify_action', 'list_notes', 'read_note', 'search_notes', 'write_note'];
const actions = ['message', 'alert', 'status', 'wake'];
const denied = () => { throw new AgentRuntimeError('DENIED', 'This capability is not permitted.'); };
export const chatAllowed = (scope, chat) => scope.includes('*') || scope.some(name => normalize(name) === normalize(chat));
const subset = (a, b) => a.filter(value => b.includes(value));
const scopeIntersection = (a, b) => a.includes('*') ? b : b.includes('*') ? a : a.filter(chat => chatAllowed(b, chat));
const strings = (value, allowed) => {
  if (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string' || !v || v.length > 300 || (allowed && !allowed.includes(v)))) throw new AgentRuntimeError('INVALID_PERMISSIONS', 'Invalid permission list.');
  return [...new Set(value)];
};

export function permissionCeiling(config = {}) {
  const c = config.agent?.ceiling || {};
  return { tools: strings(c.tools ?? TOOL_NAMES, TOOL_NAMES), readChats: strings(c.readChats ?? ['*']), writeChats: strings(c.writeChats ?? ['*']),
    initiateActions: strings(c.initiateActions ?? actions, actions), cancelIds: strings(c.cancelIds ?? ['*']), modifyIds: c.modifyIds ?? { '*': ['text'] }, sandbox: sandboxLimits(config.agent?.sandbox) };
}

export function permissions(options = {}, global, saved) {
  const requested = { tools: strings(options.tools ?? [], TOOL_NAMES), readChats: strings(options.readChats ?? []), writeChats: strings(options.writeChats ?? []),
    initiateActions: strings(options.initiateActions ?? [], actions), cancelIds: strings(options.cancelIds ?? []), modifyIds: options.modifyIds ?? {}, sandbox: sandboxLimits(options.sandbox, global.sandbox, ...(saved ? [saved.sandbox] : [])) };
  if (!requested.modifyIds || typeof requested.modifyIds !== 'object' || Array.isArray(requested.modifyIds)) throw new AgentRuntimeError('INVALID_PERMISSIONS', 'Invalid editable-action permissions.');
  for (const [id, fields] of Object.entries(requested.modifyIds)) {
    if (!id || id.length > 300) throw new AgentRuntimeError('INVALID_PERMISSIONS', 'Invalid action ID.');
    strings(fields, ['text']);
  }
  const intersect = ceiling => {
    requested.tools = subset(requested.tools, ceiling.tools);
    requested.readChats = scopeIntersection(requested.readChats, ceiling.readChats);
    requested.writeChats = scopeIntersection(requested.writeChats, ceiling.writeChats);
    requested.initiateActions = subset(requested.initiateActions, ceiling.initiateActions);
    requested.cancelIds = ceiling.cancelIds.includes('*') ? requested.cancelIds : subset(requested.cancelIds, ceiling.cancelIds);
    requested.modifyIds = Object.fromEntries(Object.entries(requested.modifyIds).map(([id, fields]) => [id, subset(fields, ceiling.modifyIds[id] || ceiling.modifyIds['*'] || [])]).filter(([, fields]) => fields.length));
  };
  intersect(global); if (saved) intersect(saved);
  return requested;
}

export function assertPermission(p, capability, chat, id, field) {
  if (!p.tools.includes(capability)) denied();
  if (chat && !chatAllowed(['read_conversation', 'search_conversations', 'read_reactions'].includes(capability) ? p.readChats : p.writeChats, chat)) denied();
  if (capability === 'cancel_action' && !p.cancelIds.includes('*') && !p.cancelIds.includes(id)) denied();
  if (capability === 'modify_action' && !(p.modifyIds[id] || p.modifyIds['*'] || []).includes(field)) denied();
}
