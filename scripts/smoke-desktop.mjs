import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, ROOT } from '../src/local-paths.mjs';
import { trayControl } from './tray-control.mjs';
import { signalKeepAwake } from '../src/desktop-signal.mjs';
import { EventEmitter } from 'node:events';

const traySource = await readFile(new URL('./windows/TeamsMonitorTray.cs', import.meta.url), 'utf8');
assert.doesNotMatch(traySource, /clos(?:e|ing) this window/i);
const refresh = traySource.slice(traySource.indexOf('async Task Refresh()'), traySource.indexOf('async Task Quit()'));
assert.doesNotMatch(refresh, /awake-policy|ReadAwakePolicy/, 'health refresh must not reread keep-awake policy');
assert.deepEqual(await signalKeepAwake({ platform: 'linux' }), { notified: false, reason: 'unavailable' });
assert.deepEqual(await signalKeepAwake(), { notified: false, reason: 'unavailable' }, 'isolated home must not signal the real installation');
for (const [code, result] of [[0, { notified: true }], [2, { notified: false, reason: 'unavailable' }], [3, { notified: false, reason: 'signal_failed' }]]) {
  assert.deepEqual(await signalKeepAwake({ platform: 'win32', home: DATA_DIR, launch: (exe, args, options) => {
    assert.equal(exe, join(DATA_DIR, 'data', 'desktop', 'TM-signal.exe'));
    assert.deepEqual(args, []); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', code)); return child;
  } }), result);
}
let killed = false;
assert.deepEqual(await signalKeepAwake({ platform: 'win32', timeoutMs: 10, launch: () => {
  const child = new EventEmitter(); child.kill = () => { killed = true; }; return child;
} }), { notified: false, reason: 'signal_failed' });
assert.equal(killed, true, 'timeout kills only the handle-owned helper');

const config = { gui: { port: 18240, authTokenEnv: 'DESKTOP_TEST_TOKEN' } };
process.env.DESKTOP_TEST_TOKEN = 'fixture';
assert.deepEqual(await trayControl('describe', { config }), { url: 'http://127.0.0.1:18240', port: 18240, controlPort: 18241 });
assert.deepEqual(await trayControl('awake-policy', { config }), { enabled: true });
assert.deepEqual(await trayControl('awake-policy', { config: { ...config, desktop: { keepAwake: false } }, request: () => { throw Error('Must read local config only'); } }), { enabled: false });
assert.deepEqual(await trayControl('awake-policy', { config: { ...config, desktop: { keepAwake: true } } }), { enabled: true });
const calls = [];
const request = async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer fixture');
  assert.equal(options.redirect, 'error');
  calls.push([new URL(url).pathname, options.method]);
  if (url.endsWith('/api/overview')) return Response.json({ orchestrator: { running: false } });
  if (url.endsWith('/api/supervisor/status')) return Response.json({ label: 'Running' });
  if (url.endsWith('/api/tunnel/status')) return Response.json({ running: true });
  return Response.json({ ok: true });
};
assert.deepEqual(await trayControl('start-components', { config, request }), { ok: true });
assert.deepEqual(calls, [['/api/overview', 'GET'], ['/api/tunnel/stop', 'POST'], ['/api/tunnel/start', 'POST'], ['/api/start', 'POST']]);
assert.deepEqual(await trayControl('status', { config, request }), { gui: 'Running', monitor: 'Stopped', tunnel: 'Running' });
calls.length = 0;
assert.equal((await trayControl('resume-components', { config, request })).ok, true);
assert.deepEqual(calls, [['/api/overview', 'GET'], ['/api/tunnel/status', 'GET'], ['/api/start', 'POST']]);
assert.equal((await trayControl('stop-components', { config, request })).ok, true);
await assert.rejects(trayControl('start-components', { config, request: async () => Response.json({ orchestrator: { stale: true } }) }), { code: 'EXISTING_MONITOR' });
await assert.rejects(trayControl('status', { config, request: async () => new Response('', { status: 401 }) }), { code: 'HTTP_401' });
assert.equal((await trayControl('stop-components', { config, request: async () => { throw Error('offline'); } })).ok, false);
assert.equal((await trayControl('prepare', { config, request })).ok, true);
await writeFile(join(DATA_DIR, 'heartbeat.json'), JSON.stringify({ pid: process.pid }));
await assert.rejects(trayControl('prepare', { config, request }), { code: 'EXISTING_MONITOR' });
await rm(join(DATA_DIR, 'heartbeat.json'));
await mkdir(join(DATA_DIR, 'supervisor'));
await writeFile(join(DATA_DIR, 'supervisor', 'control.json'), JSON.stringify({ port: 18241, token: 'b'.repeat(64) }));
await assert.rejects(trayControl('prepare', { config, request: async () => new Response('', { status: 401 }) }), { code: 'EXISTING_SUPERVISOR' });
await assert.rejects(trayControl('stop-owned', { config, ownerPid: 100, request: async () => Response.json({ supervisorPid: 101 }) }), { code: 'OWNER_CHANGED' });
await assert.rejects(trayControl('stop-owned', { config, request }), { code: 'INVALID_OWNER' });
const stoppedCalls = [];
assert.equal((await trayControl('stop-owned', { config, ownerPid: 100, request: async (url, options) => {
  stoppedCalls.push(new URL(url).pathname);
  if (new URL(url).port === '18241') assert.equal(options.headers.Authorization, 'Bearer ' + 'b'.repeat(64));
  return Response.json({ supervisorPid: 100 });
} })).ok, true);
assert.deepEqual(stoppedCalls, ['/api/supervisor/status', '/api/stop', '/api/tunnel/stop', '/status', '/stop']);

if (process.platform === 'win32') {
  const report = join(DATA_DIR, 'desktop-self-test.txt');
  const child = spawn(process.env.DESKTOP_TEST_EXE || join(ROOT, 'data', 'desktop', 'TM.exe'), ['--self-test', report], { windowsHide: true, stdio: 'ignore' });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (exit !== 0) console.error(await readFile(report + '.failed', 'utf8').catch(() => 'No self-test error report'));
  assert.equal(exit, 0);
  console.log(await readFile(report, 'utf8'));
}
console.log('Desktop tray bridge: ownership transfer order, live status, duplicate monitor refusal, authentication and offline stop passed.');
