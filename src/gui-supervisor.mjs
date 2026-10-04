import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { boundedWriter, boundedYamlWriter, errorEvidence, retainNewest } from './process-diagnostics.mjs';

async function exitedWithin(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

export function portOpen(host, port) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = open => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => finish(true)); // Unknown is not safe to start over.
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}

export async function startSupervisor({
  directory, command, cwd, healthUrl, headers = {}, controlPort,
  intervalMs = 5000, timeoutMs = 2000, startupGraceMs = 15000,
  failureThreshold = 3, maxRestarts = 5, restartWindowMs = 600000,
  backoffMs = 2000, maxBackoffMs = 30000, stableMs = 60000,
}) {
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  let stopping = false, child = null, childDone = null, wake = null;
  let status = { sessionId, supervisorPid: process.pid, state: 'starting', childPid: null };
  let writeLog;
  const record = (kind, fields = {}) => {
    try { writeLog?.({ at: new Date().toISOString(), kind, sessionId, ...fields }, true); }
    catch { process.stderr.write('Supervisor diagnostics write failed.\n'); }
  };
  const saveStatus = fields => {
    status = { ...status, ...fields, updatedAt: new Date().toISOString() };
    try {
      writeFileSync(join(directory, 'status.json.tmp'), JSON.stringify(status, null, 2));
      renameSync(join(directory, 'status.json.tmp'), join(directory, 'status.json'));
    } catch { record('status_write_failed'); }
  };
  const stop = reason => {
    if (stopping) return;
    stopping = true;
    record('stop_requested', { reason, childPid: child?.pid || null });
    saveStatus({ state: 'stopping' });
    wake?.();
    if (child) {
      record('termination_requested', { reason: 'intentional_stop', childPid: child.pid });
      child.kill('SIGKILL');
    }
  };
  const control = createServer((req, res) => {
    const given = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401); return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/status') return res.end(JSON.stringify(status));
    if (req.method === 'POST' && req.url === '/stop') {
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => stop('control_request'));
      return;
    }
    res.writeHead(404); res.end();
  });
  // The listening socket is the OS-owned single-instance lock; no stale PID kills.
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(controlPort, '127.0.0.1', resolve);
  });
  try {
    retainNewest(directory, /^session-[0-9a-f-]+$/, 4);
    const sessionDir = join(directory, `session-${sessionId}`);
    mkdirSync(sessionDir);
    writeLog = boundedYamlWriter(join(sessionDir, 'supervisor.yaml'));
    writeFileSync(join(directory, 'control.json'), JSON.stringify({ port: control.address().port, token: secret }), { mode: 0o600 });
    record('supervisor_started', { pid: process.pid, parentPid: process.ppid });
    saveStatus({ sessionDir });
  } catch (error) { control.close(); throw error; }

  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    function finish() { clearTimeout(timer); if (wake === finish) wake = null; resolve(); }
    wake = finish;
    if (stopping) finish();
  });
  const signalStop = () => stop('signal');
  process.on('SIGINT', signalStop);
  process.on('SIGTERM', signalStop);

  const loop = async () => {
    const restarts = [];
    let failures = 0;
    while (!stopping) {
      const url = new URL(healthUrl);
      if (await portOpen(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 80))) {
        record('startup_refused', { reason: 'gui_port_occupied' });
        saveStatus({ state: 'blocked', reason: 'gui_port_occupied' });
        break;
      }
      if (stopping) break;
      const runId = randomUUID();
      const runDir = join(status.sessionDir, `run-${runId}`);
      retainNewest(status.sessionDir, /^run-[0-9a-f-]+$/, 9);
      mkdirSync(runDir);
      const stdout = boundedWriter(join(runDir, 'stdout.log'));
      const stderr = boundedWriter(join(runDir, 'stderr.log'));
      const started = Date.now();
      let exited = false, outcome, everHealthy = false, lastHealthyAt = null, misses = 0, requestedTermination = null;
      child = spawn(command[0], command.slice(1), {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TEAMS_MONITOR_RUN_ID: runId, TEAMS_MONITOR_RUN_DIR: runDir },
      });
      const runChild = child;
      child.stdout.on('data', chunk => { try { stdout(chunk); } catch { record('stdout_write_failed', { runId }); } });
      child.stderr.on('data', chunk => { try { stderr(chunk); } catch { record('stderr_write_failed', { runId }); } });
      let spawnError;
      child.once('error', error => { spawnError = errorEvidence(error); });
      childDone = new Promise(resolve => child.once('close', (code, signal) => {
        exited = true;
        outcome = { code, windowsCodeHex: Number.isInteger(code) ? `0x${(code >>> 0).toString(16).padStart(8, '0')}` : null, signal, spawnError };
        wake?.();
        resolve();
      }));
      saveStatus({ state: 'starting_child', childPid: child.pid || null, runId, runDir, lastHealthyAt: null, reason: null });
      record('child_started', { runId, childPid: child.pid || null });
      while (!exited && !stopping) {
        const probeStarted = Date.now();
        try {
          const response = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
          const health = await response.json();
          if (!response.ok || health.runId !== runId || health.pid !== runChild.pid) throw new Error('identity_or_status_mismatch');
          everHealthy = true;
          lastHealthyAt = new Date().toISOString();
          if (misses || status.state !== 'healthy') record('health_restored', { runId, latencyMs: Date.now() - probeStarted });
          misses = 0;
          saveStatus({ state: 'healthy', lastHealthyAt, consecutiveFailures: 0, healthLatencyMs: Date.now() - probeStarted });
        } catch {
          if (exited || stopping) break;
          if (Date.now() - started >= startupGraceMs) {
            misses++;
            record('health_failed', { runId, consecutiveFailures: misses, lastHealthyAt, latencyMs: Date.now() - probeStarted });
            saveStatus({ state: 'unresponsive', consecutiveFailures: misses });
            if (misses >= failureThreshold) {
              requestedTermination = 'health_timeout';
              record('termination_requested', { runId, childPid: runChild.pid, reason: requestedTermination });
              runChild.kill('SIGKILL');
              break;
            }
          }
        }
        if (!exited) await sleep(intervalMs);
      }
      // Never launch a replacement until the owned child is confirmed gone.
      let terminationLate = false;
      if (!await exitedWithin(childDone, 5000)) {
        record('termination_unconfirmed', { runId });
        saveStatus({ state: 'blocked', reason: 'termination_unconfirmed' });
        terminationLate = true;
        await childDone;
      }
      child = null;
      record('child_exited', { runId, childPid: runChild.pid || null, ...outcome, uptimeMs: Date.now() - started, lastHealthyAt, requestedTermination: stopping ? 'intentional_stop' : requestedTermination });
      saveStatus({ childPid: null, lastExit: outcome });
      if (stopping) break;
      if (terminationLate) break;
      if (!requestedTermination && [0, 130, 143].includes(outcome.code)) {
        saveStatus({ state: 'stopped', reason: 'child_normal_exit' });
        record('normal_exit_no_restart', { runId });
        break;
      }
      if (!everHealthy && !requestedTermination) {
        saveStatus({ state: 'blocked', reason: 'startup_failure' });
        record('startup_failure_no_restart', { runId });
        break;
      }
      const now = Date.now();
      while (restarts.length && restarts[0] < now - restartWindowMs) restarts.shift();
      if (restarts.length >= maxRestarts) {
        record('restart_limit_reached', { maxRestarts, restartWindowMs });
        saveStatus({ state: 'blocked', reason: 'restart_limit_reached' });
        break;
      }
      if (everHealthy && now - started >= stableMs) failures = 0;
      const waitMs = Math.min(backoffMs * 2 ** failures++, maxBackoffMs);
      restarts.push(now);
      record('restart_scheduled', { waitMs, restartsInWindow: restarts.length });
      saveStatus({ state: 'backoff', restartAt: new Date(now + waitMs).toISOString() });
      await sleep(waitMs);
    }
  };
  const running = loop().catch(error => {
    record('supervisor_error', errorEvidence(error));
    stop('supervisor_error');
  });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  // Keep the control endpoint available when blocked, so status/stop still work.
  const shutdownTimer = setInterval(async () => {
    if (!stopping) return;
    clearInterval(shutdownTimer);
    await running;
    if (child) {
      record('stop_incomplete', { childPid: child.pid });
      // Do not pretend a still-owned child stopped or release the instance lock.
      return;
    }
    saveStatus({ state: 'stopped' });
    record('supervisor_stopped');
    process.off('SIGINT', signalStop);
    process.off('SIGTERM', signalStop);
    control.closeAllConnections();
    control.close(() => resolveDone());
  }, 100);
  return { stop, done, status: () => status, controlPort: control.address().port };
}
