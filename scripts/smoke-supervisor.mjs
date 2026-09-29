import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { startSupervisor } from '../src/gui-supervisor.mjs';
import { boundedWriter, retainNewest } from '../src/process-diagnostics.mjs';
import { DATA_DIR, ROOT } from '../src/local-paths.mjs';
import { loadConfig, saveConfig } from '../src/context.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert(Date.now() < deadline, `Timed out: ${label}`); await sleep(20); }
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const active = [];
async function launch(mode, extra = {}) {
  const port = await freePort();
  const directory = join(DATA_DIR, `test-${mode}-${port}`);
  const supervisor = await startSupervisor({
    directory, command: [process.execPath, 'scripts/fixtures/supervisor-child.mjs', mode, String(port)],
    cwd: ROOT, healthUrl: `http://127.0.0.1:${port}/api/liveness`, controlPort: 0,
    intervalMs: 50, timeoutMs: 250, startupGraceMs: 2500, failureThreshold: 2,
    maxRestarts: 1, restartWindowMs: 10000, backoffMs: 40, maxBackoffMs: 80,
    ...extra,
  });
  active.push(supervisor);
  return { supervisor, directory, events: () => readFileSync(join(supervisor.status().sessionDir, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
async function stop(supervisor) { supervisor.stop('test'); await supervisor.done; }

try {
  for (const mode of ['normal', 'exit', 'signal', 'startup_failure']) {
    const test = await launch(mode);
    await until(() => ['stopped', 'blocked'].includes(test.supervisor.status().state), mode);
    assert(!test.events().some(e => e.kind === 'restart_scheduled'), JSON.stringify({ mode, events: test.events() }));
    assert.equal(test.supervisor.status().reason, mode === 'startup_failure' ? 'startup_failure' : 'child_normal_exit');
    await stop(test.supervisor);
  }
  for (const [mode, kind] of [['throw', 'uncaught_exception'], ['reject', 'unhandled_rejection'], ['hang', null]]) {
    const test = await launch(mode);
    await until(() => test.supervisor.status().reason === 'restart_limit_reached', mode);
    const events = test.events();
    assert.equal(events.filter(e => e.kind === 'restart_scheduled').length, 1);
    assert(events.some(e => e.kind === 'child_exited' && e.lastHealthyAt && (e.windowsCodeHex || e.signal)), JSON.stringify(events));
    if (kind) {
      const runDir = test.supervisor.status().runDir;
      const file = readdirSync(runDir).find(name => name.endsWith('.jsonl'));
      const log = readFileSync(join(runDir, file), 'utf8');
      assert(log.includes(kind));
      assert(!log.includes('private'));
    } else assert(events.some(e => e.kind === 'termination_requested' && e.reason === 'health_timeout'));
    await stop(test.supervisor);
  }
  const external = await launch('spawn_output');
  await until(() => external.supervisor.status().state === 'healthy', 'initial health');
  const firstPid = external.supervisor.status().childPid;
  process.kill(firstPid, 'SIGKILL');
  try { await until(() => external.supervisor.status().state === 'healthy' && external.supervisor.status().childPid !== firstPid, 'external termination restart'); }
  catch (error) { console.error(external.events()); throw error; }
  assert(external.events().some(e => e.kind === 'child_exited' && e.requestedTermination === null));
  assert(readFileSync(join(external.supervisor.status().runDir, 'stdout.log'), 'utf8').includes('stdout fixture'));
  assert(readFileSync(join(external.supervisor.status().runDir, 'stderr.log'), 'utf8').includes('stderr fixture'));
  await assert.rejects(startSupervisor({ directory: join(DATA_DIR, 'duplicate'), command: [], cwd: ROOT, healthUrl: 'http://127.0.0.1:1', controlPort: external.supervisor.controlPort }), error => error.code === 'EADDRINUSE');
  const access = JSON.parse(readFileSync(join(external.directory, 'control.json'), 'utf8'));
  assert.equal((await fetch(`http://127.0.0.1:${access.port}/stop`, { method: 'POST' })).status, 401);
  const response = await fetch(`http://127.0.0.1:${access.port}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${access.token}` } });
  assert.equal(response.status, 200);
  await external.supervisor.done;
  assert.equal(external.supervisor.status().state, 'stopped');

  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const test = await launch('normal', { healthUrl: `http://127.0.0.1:${occupied.address().port}/` });
    await until(() => test.supervisor.status().reason === 'gui_port_occupied', 'occupied port');
    assert(!test.events().some(e => e.kind === 'child_started'));
    await stop(test.supervisor);
  } finally { occupied.close(); }
  const missing = await launch('normal', { command: [join(ROOT, 'does-not-exist.exe')] });
  await until(() => missing.supervisor.status().reason === 'startup_failure', 'spawn failure');
  assert(missing.events().some(e => e.kind === 'child_exited' && e.spawnError?.code === 'ENOENT'));
  await stop(missing.supervisor);
  const backoff = await launch('throw', { backoffMs: 3000 });
  await until(() => backoff.supervisor.status().state === 'backoff', 'backoff');
  await stop(backoff.supervisor);
  assert.equal(backoff.events().filter(e => e.kind === 'child_started').length, 1);

  // Real bootstrap and GUI, not just a fixture: auth and identity must agree.
  const realPort = await freePort();
  const config = await loadConfig();
  config.gui = { host: '127.0.0.1', port: realPort, authTokenEnv: 'SUPERVISOR_SMOKE_TOKEN' };
  await saveConfig(config);
  process.env.SUPERVISOR_SMOKE_TOKEN = 'test-only';
  const real = await launch('real', {
    directory: join(DATA_DIR, 'supervisor'),
    command: [process.execPath, 'src/cli.mjs', 'gui'],
    healthUrl: `http://127.0.0.1:${realPort}/api/liveness`,
    headers: { Authorization: 'Bearer test-only' }, startupGraceMs: 3000,
  });
  await until(() => real.supervisor.status().state === 'healthy', 'real GUI health');
  assert.equal((await fetch(`http://127.0.0.1:${realPort}/api/liveness`)).status, 401);
  const stopCommand = spawn(process.execPath, ['scripts/gui-supervisor.mjs', 'stop'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopOutput = '';
  stopCommand.stdout.on('data', data => { stopOutput += data; });
  stopCommand.stderr.on('data', data => { stopOutput += data; });
  const stopCode = await new Promise((resolve, reject) => { stopCommand.once('error', reject); stopCommand.once('close', resolve); });
  assert.equal(stopCode, 0, stopOutput);
  assert(stopOutput.includes('GUI and supervisor stopped'));
  await real.supervisor.done;

  const rotated = join(DATA_DIR, 'rotation');
  mkdirSync(rotated);
  const writer = boundedWriter(join(rotated, 'output.log'), 64, 2);
  writer('x'.repeat(1000));
  assert.equal(readdirSync(rotated).length, 3);
  assert(readdirSync(rotated).every(name => readFileSync(join(rotated, name)).length <= 64));
  retainNewest(rotated, /^output\.log/, 1);
  assert.equal(readdirSync(rotated).length, 1);
  console.log('Supervisor smoke passed: fatal/normal exits, external kill, hangs, restart cap, backoff stop, duplicate/occupied ports, spawn failure, authenticated stop, output rotation.');
} finally { await Promise.all(active.map(stop)); }
