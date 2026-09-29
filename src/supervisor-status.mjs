import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './local-paths.mjs';
import { processRunId } from './process-diagnostics.mjs';

// Query the live authenticated control endpoint, never treat an old status file
// or a reused PID as evidence that this GUI is still being supervised.
export async function supervisorStatus({ directory = join(DATA_DIR, 'supervisor'), pid = process.pid, runId = processRunId, now = Date.now(), request = fetch } = {}) {
  const result = (state, label, tone, detail, extra = {}) => ({ state, label, tone, detail, checkedAt: new Date(now).toISOString(), ...extra });
  let access;
  try { access = JSON.parse(await readFile(join(directory, 'control.json'), 'utf8')); }
  catch (error) {
    return error.code === 'ENOENT'
      ? result('unmanaged', 'Not supervised', 'warn', 'No supervisor control information. Start with bun run gui.')
      : result('invalid', 'Invalid status', 'warn', 'Supervisor control information could not be read.');
  }
  if (!Number.isInteger(access?.port) || access.port < 1 || access.port > 65535 || !/^[a-f0-9]{64}$/.test(access?.token)) {
    return result('invalid', 'Invalid status', 'warn', 'Invalid supervisor control information.');
  }
  let value;
  try {
    const response = await request(`http://127.0.0.1:${access.port}/status`, {
      headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(1000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Control unavailable');
    value = await response.json();
  } catch {
    return result('unavailable', 'Not responding', 'bad', 'Cannot reach the supervisor. Automatic GUI recovery is not confirmed.');
  }
  const labels = { starting: ['Starting', 'neutral'], starting_child: ['Starting GUI', 'neutral'], healthy: ['Running', 'good'], unresponsive: ['GUI check failing', 'warn'], backoff: ['Restart pending', 'warn'], blocked: ['Blocked', 'bad'], stopping: ['Stopping', 'warn'], stopped: ['Stopped', 'warn'] };
  if (!value || !Object.hasOwn(labels, value.state) || !Number.isInteger(value.supervisorPid) || value.supervisorPid <= 0 || !Number.isFinite(Date.parse(value.updatedAt))) {
    return result('invalid', 'Invalid status', 'warn', 'Supervisor returned invalid status data.');
  }
  const updatedAt = new Date(value.updatedAt).toISOString();
  const lastHealthyAt = Number.isFinite(Date.parse(value.lastHealthyAt)) ? new Date(value.lastHealthyAt).toISOString() : null;
  const extra = { supervisorPid: value.supervisorPid, updatedAt, lastHealthyAt };
  const reasons = { restart_limit_reached: 'Restart limit reached; inspect logs before restarting.', startup_failure: 'GUI startup failed.', gui_port_occupied: 'GUI port is already occupied.', termination_unconfirmed: 'GUI termination has not been confirmed.', child_normal_exit: 'GUI exited normally; automatic restart is disabled.' };
  if (['blocked', 'stopped', 'stopping'].includes(value.state)) {
    return result(value.state, ...labels[value.state], reasons[value.reason] || 'Automatic recovery is not active for this GUI.', extra);
  }
  if (value.childPid !== pid || value.runId !== runId) {
    return result('unmanaged', 'Not supervised', 'warn', 'A supervisor is reachable, but it is not watching this GUI process.', extra);
  }
  const age = now - Date.parse(updatedAt);
  if (age > 20000 || age < -5000) return result('stale', 'Status stale', 'warn', 'Supervisor responds, but its monitoring loop has not reported a recent status.', extra);
  return result(value.state, ...labels[value.state], value.state === 'healthy' ? 'Watching this GUI; automatic recovery is active.' : 'Supervisor is checking this GUI.', extra);
}
