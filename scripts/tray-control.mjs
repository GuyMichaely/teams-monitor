// Local tray bridge. Credentials stay in Bun's environment, never command lines or tray logs.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/context.mjs';
import { DATA_DIR } from '../src/local-paths.mjs';

export async function trayControl(action, { config, request = fetch, ownerPid } = {}) {
  config ||= await loadConfig();
  const gui = config.gui || {};
  const port = gui.port || 8090;
  const url = `http://127.0.0.1:${port}`;
  const token = process.env[gui.authTokenEnv || 'GUI_TOKEN'];
  const call = async (path, method = 'GET') => {
    const response = await request(url + path, {
      method, headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw Object.assign(Error('Local control failed'), { code: `HTTP_${response.status}` });
    return response.json();
  };
  if (action === 'describe') return { url, port, controlPort: port + 1 };
  if (action === 'awake-policy') return { enabled: config.desktop?.keepAwake !== false };
  if (action === 'prepare') {
    // Refuse to take over an existing GUI. Only a live authenticated supervisor can stop itself.
    let access;
    try { access = JSON.parse(await readFile(join(DATA_DIR, 'supervisor', 'control.json'), 'utf8')); } catch {}
    if (access?.port === port + 1 && /^[a-f0-9]{64}$/.test(access.token)) {
      let live;
      try {
        live = await request(`http://127.0.0.1:${access.port}/status`, {
          headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(1000), redirect: 'error',
        });
      } catch {}
      if (live) throw Object.assign(Error('Existing supervisor'), { code: 'EXISTING_SUPERVISOR' });
    }
    // Refuse an external monitor; a heartbeat PID is never authority to take ownership.
    let heartbeat;
    try { heartbeat = JSON.parse(await readFile(join(DATA_DIR, 'heartbeat.json'), 'utf8')); } catch {}
    if (Number.isInteger(heartbeat?.pid) && heartbeat.pid > 0) {
      let alive = false;
      try { process.kill(heartbeat.pid, 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw Object.assign(Error('Monitor unknown'), { code: 'MONITOR_STATE_UNKNOWN' }); }
      if (alive) throw Object.assign(Error('External monitor'), { code: 'EXISTING_MONITOR' });
    }
    return { ok: true };
  }
  if (action === 'start-components') {
    const overview = await call('/api/overview');
    if (overview.orchestrator?.running || overview.orchestrator?.stale) {
      throw Object.assign(Error('Existing monitor'), { code: 'EXISTING_MONITOR' });
    }
    // Recreate the project's existing tunnel under the tray-owned GUI process.
    const stopped = await call('/api/tunnel/stop', 'POST');
    if (stopped.reason === 'kill-failed') throw Object.assign(Error('Tunnel stop failed'), { code: 'TUNNEL_STOP_FAILED' });
    await call('/api/tunnel/start', 'POST');
    await call('/api/start', 'POST');
    return { ok: true };
  }
  if (action === 'resume-components') {
    const [overview, tunnel] = await Promise.all([call('/api/overview'), call('/api/tunnel/status')]);
    if (!tunnel.running) await call('/api/tunnel/start', 'POST');
    if (!overview.orchestrator?.running && !overview.orchestrator?.stale) await call('/api/start', 'POST');
    return { ok: true };
  }
  if (action === 'status') {
    const [supervisor, overview, tunnel] = await Promise.all([
      call('/api/supervisor/status'), call('/api/overview'), call('/api/tunnel/status'),
    ]);
    return {
      gui: supervisor.label,
      monitor: overview.orchestrator?.running ? 'Running' : overview.orchestrator?.stale ? 'Not responding' : 'Stopped',
      tunnel: tunnel.running ? 'Running' : 'Stopped',
    };
  }
  if (action === 'stop-components') {
    const results = await Promise.allSettled([call('/api/stop', 'POST'), call('/api/tunnel/stop', 'POST')]);
    return { ok: results.every(item => item.status === 'fulfilled') };
  }
  if (action === 'stop-owned') {
    // A refused/failed launch must never stop another supervisor's system.
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw Object.assign(Error('Missing owner'), { code: 'INVALID_OWNER' });
    const identity = await call('/api/supervisor/status');
    if (identity.supervisorPid !== ownerPid) throw Object.assign(Error('Owner changed'), { code: 'OWNER_CHANGED' });
    await Promise.allSettled([call('/api/stop', 'POST'), call('/api/tunnel/stop', 'POST')]);
    const access = JSON.parse(await readFile(join(DATA_DIR, 'supervisor', 'control.json'), 'utf8'));
    if (access.port !== port + 1 || !/^[a-f0-9]{64}$/.test(access.token)) throw Object.assign(Error('Invalid control'), { code: 'INVALID_CONTROL' });
    const options = { headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' };
    const response = await request(`http://127.0.0.1:${access.port}/status`, options);
    if (!response.ok || (await response.json()).supervisorPid !== ownerPid) throw Object.assign(Error('Owner changed'), { code: 'OWNER_CHANGED' });
    const stopped = await request(`http://127.0.0.1:${access.port}/stop`, { ...options, method: 'POST' });
    if (!stopped.ok) throw Object.assign(Error('Stop failed'), { code: 'SUPERVISOR_STOP_FAILED' });
    return { ok: true };
  }
  throw Object.assign(Error('Unknown tray command'), { code: 'INVALID_COMMAND' });
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await trayControl(process.argv[2], { ownerPid: Number(process.argv[3]) }))); }
  catch (error) {
    // No arbitrary API/error text: the tray displays fixed explanations for these codes.
    console.log(JSON.stringify({ error: error.code || 'LOCAL_CONTROL_FAILED' }));
    process.exitCode = 1;
  }
}
