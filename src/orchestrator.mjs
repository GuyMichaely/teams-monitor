import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './local-paths.mjs';

const STOP_FILE = join(DATA_DIR, 'STOP'), HEARTBEAT_FILE = join(DATA_DIR, 'heartbeat.json');
export function requestStop() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STOP_FILE, `stop requested ${new Date().toISOString()}\n`);
}

// Break glass: only a fresh heartbeat permits signalling, never an old PID file.
export function hardStop({ maxHeartbeatAgeMs = 120000 } = {}) {
  requestStop();
  let hb;
  try { hb = JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf8')); }
  catch { return { killed: false, reason: 'no heartbeat file' }; }
  const pid = hb?.pid, age = Date.now() - Date.parse(hb.at);
  if (!pid || !(age >= 0 && age < maxHeartbeatAgeMs)) return { killed: false, pid, reason: 'stale or invalid heartbeat; not killing' };
  try {
    process.kill(pid, 'SIGKILL');
    rmSync(HEARTBEAT_FILE, { force: true }); rmSync(STOP_FILE, { force: true });
    return { killed: true, pid };
  } catch (error) {
    if (error.code === 'ESRCH') return { killed: false, pid, reason: 'process not found' };
    throw error;
  }
}

export async function run() {
  const [{ runEngine }, { evaluatePolicy }] = await Promise.all([import('./agent/engine.mjs'), import('./agent/policy.mjs')]);
  return runEngine({ handle: evaluatePolicy,
    onWake: (ctx, options) => evaluatePolicy(ctx, { ...options, handler: 'onWake' }),
    onActionResult: (ctx, options) => evaluatePolicy(ctx, { ...options, handler: 'onActionResult' }) });
}
