import { spawn } from 'node:child_process';
import { openSync, closeSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../src/local-paths.mjs';
import { loadConfig } from '../src/context.mjs';
import { startGui } from '../src/gui-server.mjs';
import { orchestratorStatus } from '../src/gui-server-core.mjs';
import { authOk } from '../src/gui-diagnostics.mjs';
import { requestStop } from '../src/orchestrator.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function startPreview(config) {
  if (process.env.TEAMS_MONITOR_DEV !== '1' || config.port !== 29222) throw Error('Preview requires isolated development state and mock Teams.');
  let status = 'available', sequence = 0, child, closing = false, queue = Promise.resolve();
  const messages = [], fixtureId = randomUUID();
  const gui = startGui(config, {
    get: async () => ({ connected: true, value: status, status, verified: true }),
    set: async value => { status = value; return { value, status, verified: true }; },
  }, {
    config: loadConfig, unread: async () => ['Fixture chat'],
    read: async () => ({ chat: 'Fixture chat', messages: [...messages] }),
    send: async () => { throw Error('Development sends are disabled; use isolated replay/smokes.'); },
  });
  if (!gui.server.listening) await once(gui.server, 'listening');
  const produce = () => {
    messages.push({ id: fixtureId + '-' + ++sequence, author: 'Fixture author', text: 'Development message ' + sequence, time: new Date().toISOString(), reactions: [] });
    if (messages.length > 15) messages.shift();
  };
  produce(); const timer = setInterval(produce, 30000);
  const live = () => child && child.exitCode === null && child.signalCode === null;
  const serialized = task => {
    const result = queue.then(task); queue = result.catch(() => {}); return result;
  };
  const start = () => serialized(async () => {
    if (closing) throw Error('Preview is closing.');
    if (live()) return { ok: true, pid: child.pid, alreadyRunning: true };
    const health = await orchestratorStatus(config.pollIntervalMs);
    if (health.running || health.stale) throw Error('An external preview monitor is running; stop its terminal first.');
    rmSync(join(DATA_DIR, 'STOP'), { force: true });
    const out = openSync(join(DATA_DIR, 'orchestrator.log'), 'a');
    try {
      // The GUI owns this exact handle, never adopts/kills a heartbeat PID.
      child = spawn(process.execPath, ['--no-env-file', join(root, 'src', 'cli.mjs'), 'run'], {
        cwd: root, windowsHide: true, stdio: ['ignore', out, out], env: process.env,
      });
      const owned = child;
      await once(owned, 'spawn');
      owned.on('error', () => {});
      return { ok: true, pid: owned.pid };
    } finally { closeSync(out); }
  });
  const stop = () => serialized(async () => {
    if (!live()) return { ok: true, stopped: true };
    const owned = child;
    requestStop();
    let timeout;
    const exit = once(owned, 'exit');
    try {
      await Promise.race([exit, new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]);
      if (owned.exitCode === null && owned.signalCode === null) {
        owned.kill('SIGKILL');
        await exit;
      }
    } finally { clearTimeout(timeout); }
    return { ok: true, stopped: true };
  });
  const handler = gui.server.listeners('request')[0];
  gui.server.removeListener('request', handler);
  const token = process.env[config.gui.authTokenEnv];
  gui.server.on('request', async (req, res) => {
    if (req.method !== 'POST' || !['/api/start', '/api/stop'].includes(req.url)) return handler(req, res);
    res.setHeader('Content-Type', 'application/json');
    if (!token || !authOk(req.headers.authorization, token)) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
    try { res.end(JSON.stringify(await (req.url === '/api/start' ? start() : stop()))); }
    catch { res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'Preview monitor could not start/stop; check its local log.' })); }
  });
  return { ...gui, start, stop, close: async () => {
    if (closing) return queue;
    closing = true; clearInterval(timer);
    try { await stop(); } finally { await gui.close(); }
  } };
}
