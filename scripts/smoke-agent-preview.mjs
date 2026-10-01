import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { startPreview } from './agentic-preview.mjs';

process.env.TEAMS_MONITOR_DEV = '1';
process.env.AGENTIC_GUI_TOKEN = 'preview-smoke';
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const config = await loadConfig();
Object.assign(config, { port: 29222, pollIntervalMs: 250, gui: { port, host: '127.0.0.1', authTokenEnv: 'AGENTIC_GUI_TOKEN' } });
await saveConfig(config);
const base = `http://127.0.0.1:${port}`;
const api = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { Authorization: 'Bearer preview-smoke', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); return response.json();
};
const until = async check => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Preview transition timed out.');
};
const preview = await startPreview(config);
try {
  assert.equal((await fetch(base + '/api/start', { method: 'POST' })).status, 401);
  const first = await api('/api/start', 'POST');
  assert.notEqual(first.pid, process.pid, 'monitor must not share GUI PID');
  await until(async () => (await api('/api/overview')).orchestrator.running);
  assert.equal((await api('/api/agent/prompt', 'POST', { prompt: 'Preview only; no actions.', contextId: 'preview-smoke' })).state, 'pending');
  await until(async () => (await api('/api/agent/status')).records.some(row => row.kind === 'agent_result' && row.value?.output === 'Development model fixture. No proposed actions.'));
  await api('/api/stop', 'POST');
  assert.equal((await api('/api/overview')).orchestrator.running, false);
  assert.equal((await api('/api/liveness')).pid, process.pid, 'Stop monitor must leave GUI running');
  const second = await api('/api/start', 'POST');
  assert.notEqual(second.pid, first.pid);
  await until(async () => (await api('/api/overview')).orchestrator.running);
  await preview.close();
  assert.throws(() => process.kill(second.pid, 0), 'Closing preview must stop its owned monitor');
  await assert.rejects(fetch(base + '/api/liveness', { signal: AbortSignal.timeout(500) }));
} finally { await preview.close(); }
console.log('PASS isolated preview: separate monitor PID, authenticated controls, Stop/Start and owned shutdown.');
