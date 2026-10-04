import { AgentRuntimeError } from './agent/errors.mjs';
import { readReceipt } from './teams-read-state.mjs';

export function teamsClient(config, owner) {
  const base = `http://127.0.0.1:${config.gui?.port || 8090}`;
  const token = process.env[config.gui?.authTokenEnv || 'GUI_TOKEN'];
  const request = async (path, body, signal) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), redirect: 'error' });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new AgentRuntimeError('TEAMS_UNAVAILABLE', 'GUI Teams operation was not confirmed.'), { scheduleCode: result.scheduleCode });
    return result;
  };
  return {
    unread: signal => request('/api/teams/operation', { operation: 'unread' }, signal),
    read: (chat, signal) => request('/api/teams/operation', { operation: 'read', chat }, signal),
    markRead: (chat, messages, signal) => request('/api/teams/operation', { operation: 'mark_read', chat, receipt: readReceipt(messages), owner }, signal),
    send: (chat, text, expiresAt, signal, action) => request('/api/teams/operation', { operation: 'send', chat, text, expiresAt, owner, action }, signal),
    async status(presence, expiresAt, signal, action) {
      const response = await fetch(base + '/api/teams/presence', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ status: presence, expiresAt, owner, action }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), redirect: 'error' });
      if (!response.ok) throw new AgentRuntimeError('TEAMS_UNAVAILABLE', 'Teams status was not confirmed.');
      return response.json();
    },
  };
}
