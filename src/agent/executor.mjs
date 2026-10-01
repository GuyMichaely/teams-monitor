import { isReplyAllowed } from '../reply-policy.mjs';
import { sendAlert } from '../alerts.mjs';
import { AgentRuntimeError, failure } from './errors.mjs';
import { permissionCeiling, permissions, chatAllowed } from './permissions.mjs';

export function validateAction(value) {
  if (!value || typeof value !== 'object' || !['message', 'alert', 'status', 'wake'].includes(value.kind))
    throw new AgentRuntimeError('INVALID_ACTION', 'Unknown action kind.');
  if (value.due !== undefined && (!Number.isSafeInteger(value.due) || value.due < 0 || value.due > Date.now() + 366 * 86400000))
    throw new AgentRuntimeError('INVALID_ACTION', 'Invalid action time.');
  if (['message', 'alert'].includes(value.kind) && (typeof value.chat !== 'string' || !value.chat.trim() || value.chat.length > 300 ||
      typeof value.text !== 'string' || !value.text.trim() || value.text.length > 8000))
    throw new AgentRuntimeError('INVALID_ACTION', 'Action needs a chat and text.');
  if (value.kind === 'status' && !['available', 'busy', 'dnd', 'brb', 'away', 'offline'].includes(value.presence))
    throw new AgentRuntimeError('INVALID_ACTION', 'Invalid Teams status.');
  if (value.kind === 'wake' && (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000 || typeof value.contextId !== 'string' || !value.contextId || !value.ceiling))
    throw new AgentRuntimeError('INVALID_ACTION', 'Wake needs a prompt, context ID and permission ceiling.');
  if (value.kind === 'wake') permissions(value.ceiling, permissionCeiling());
  return value;
}

export function assertActionAuthority(action, cfg, store) {
  if (action.origin === 'agent' || action.authority) {
    const p = permissions(action.authority, permissionCeiling(cfg)), capability = { message: 'send_message', alert: 'alert', status: 'set_status', wake: 'schedule' }[action.kind];
    if (store.mode() !== 'active' || !p.tools.includes(capability) || !p.initiateActions.includes(action.kind) ||
        (action.kind === 'message' && !chatAllowed(p.writeChats, action.chat))) throw new AgentRuntimeError('DENIED', 'Current agent permissions block this action.');
  }
  if (action.review) {
    const p = permissions(action.review.authority, permissionCeiling(cfg));
    if (store.mode() !== 'active' || !p.tools.includes('modify_action') || !(p.modifyIds[action.id] || p.modifyIds['*'] || []).includes('text'))
      throw new AgentRuntimeError('DENIED', 'Current permissions block the reviewed action.');
  }
}

export async function executeAction({ store, client, loadConfig, stopped = () => false, alert = sendAlert, wake, onResult = () => {}, now = Date.now }) {
  if (stopped()) return null;
  const job = store.claimAction(now());
  if (!job) return null;
  let state = 'uncertain', result;
  try {
    const action = validateAction(job.value);
    const cfg = await loadConfig();
    if (stopped()) throw new AgentRuntimeError('STOPPED', 'Stopped before execution.');
    if (action.kind !== 'wake' && now() > job.due + 300000) throw new AgentRuntimeError('MISSED', 'More than five minutes late.');
    if (action.kind === 'message' && !isReplyAllowed(cfg, action.chat)) throw new AgentRuntimeError('DENIED', 'Current reply policy blocks this chat.');
    assertActionAuthority(action, cfg, store);
    const expiresAt = Math.min(job.due + 300000, now() + 300000);
    if (action.kind === 'message') {
      result = await client.send(action.chat, action.text, expiresAt, undefined, action);
      if (result.result === 'sent') state = 'completed';
    } else if (action.kind === 'alert') {
      // Stable ID survives dual transport attempts; a claimed attempt is never replayed.
      result = process.env.TEAMS_MONITOR_DEV === '1' ? { simulated: true, alertId: job.id } : await alert({ ...action, alertId: job.id }, cfg);
      state = 'completed';
    } else if (action.kind === 'status') {
      result = await client.status(action.presence, expiresAt, undefined, action);
      if (result.superseded) state = 'superseded';
      else if (result.verified && result.value === action.presence) state = 'completed';
      else if (result.expired && !result.attempted) state = 'missed';
    } else {
      result = await wake?.({ ...action, latenessMs: Math.max(0, now() - job.due), actionId: job.id });
      if (!result) throw new AgentRuntimeError('UNAVAILABLE', 'Wake handler is unavailable.');
      state = result.ok ? 'completed' : 'failed';
    }
  } catch (error) {
    result = failure(error);
    if (error.code === 'DENIED' || error.scheduleCode === 'blocked') state = 'blocked';
    else if (['MISSED', 'STOPPED'].includes(error.code) || ['expired', 'stopped'].includes(error.scheduleCode)) state = 'missed';
    else if (['INVALID_ACTION', 'UNAVAILABLE'].includes(error.code) || ['draft', 'destination', 'config'].includes(error.scheduleCode)) state = 'failed';
    // Network/unknown errors can follow an effect; do not guess or retry.
  }
  const outcome = { id: job.id, action: job.value, state, result };
  store.finishAction(job.id, job.attempt, state, result);
  store.record(job.runId, 'action_result', outcome);
  await Promise.resolve(onResult(outcome, job)).catch(() => {});
  return outcome;
}
