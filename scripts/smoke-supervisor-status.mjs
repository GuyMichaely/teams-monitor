import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../src/local-paths.mjs';
import { supervisorStatus } from '../src/supervisor-status.mjs';
import { startGui } from '../src/gui-server.mjs';
import { DASHBOARD_PAGE } from '../src/dashboard-page.mjs';

const directory = join(DATA_DIR, 'supervisor');
await mkdir(directory);
assert.equal((await supervisorStatus()).state, 'unmanaged');
await writeFile(join(directory, 'control.json'), '{');
assert.equal((await supervisorStatus()).state, 'invalid');
await writeFile(join(directory, 'control.json'), JSON.stringify({ port: 12345, token: 'a'.repeat(64) }));
const now = Date.now();
const base = { state: 'healthy', supervisorPid: 123, childPid: 456, runId: 'current-run', updatedAt: new Date(now).toISOString(), lastHealthyAt: new Date(now).toISOString(), token: 'must-not-leak', sessionDir: 'private-path' };
const check = value => supervisorStatus({ pid: 456, runId: 'current-run', now, request: async (url, options) => {
  assert.equal(url, 'http://127.0.0.1:12345/status');
  assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
  assert.equal(options.redirect, 'error');
  return Response.json(value);
} });
assert.equal((await check(base)).label, 'Running');
assert.equal((await check({ ...base, childPid: 457 })).state, 'unmanaged');
assert.equal((await check({ ...base, runId: 'reused-pid' })).state, 'unmanaged');
assert.equal((await check({ ...base, updatedAt: new Date(now - 21000).toISOString() })).state, 'stale');
assert.equal((await check({ ...base, updatedAt: new Date(now + 10000).toISOString() })).state, 'stale');
assert.equal((await check({ ...base, state: 'blocked', reason: 'restart_limit_reached', childPid: null })).label, 'Blocked');
assert.equal((await check({ ...base, state: 'stopped', childPid: null })).label, 'Stopped');
for (const value of [null, {}, { ...base, state: '__proto__' }, { ...base, updatedAt: 'invalid' }]) assert.equal((await check(value)).state, 'invalid');
assert.equal((await supervisorStatus({ request: async () => { throw Error('offline'); } })).state, 'unavailable');
assert.equal((await supervisorStatus({ request: async () => new Response('', { status: 401 }) })).state, 'unavailable');
const safe = JSON.stringify(await check(base));
assert(!safe.includes('must-not-leak') && !safe.includes('private-path') && !safe.includes('aaaa'));

process.env.SUPERVISOR_STATUS_TEST_TOKEN = 'smoke-token';
const { server, close } = startGui({ gui: { host: '127.0.0.1', port: 18131, authTokenEnv: 'SUPERVISOR_STATUS_TEST_TOKEN' } });
try {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:18131/api/supervisor/status';
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: 'Bearer smoke-token' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).state, 'unavailable');
  assert(DASHBOARD_PAGE.includes('id="supervisorHealth"'));
  assert(!DASHBOARD_PAGE.includes('supervisorDetail'), 'Supervisor row has no subtitle or dangling client reference');
  const client = DASHBOARD_PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(client); // Syntax check including the embedded client.
  const refresh = client.slice(client.indexOf('async function refreshSupervisor'), client.indexOf('async function perform'));
  assert(!refresh.includes('paused'), 'Supervisor checks must continue while log tailing is paused');
  assert(client.includes('setInterval(refreshSupervisor, 5000)'));
  console.log('Supervisor status: live identity, stale/offline/unmanaged/blocked/corrupt states, token privacy, authenticated API and UI wiring passed.');
} finally { await close(); }
