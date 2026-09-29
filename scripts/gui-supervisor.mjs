import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ROOT } from '../src/local-paths.mjs';
import { installLifecycle } from '../src/process-diagnostics.mjs';

const lifecycle = installLifecycle('supervisor');
const directory = join(DATA_DIR, 'supervisor');
try {
  const action = process.argv[2] || 'start';
  if (action === 'status' || action === 'stop') {
    const access = JSON.parse(readFileSync(join(directory, 'control.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${access.port}/${action}`, {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Supervisor control rejected');
    if (action === 'status') console.log(JSON.stringify(await response.json(), null, 2));
    else {
      const deadline = Date.now() + 10000;
      let stopped = false;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
          const check = await fetch(`http://127.0.0.1:${access.port}/status`, {
            headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(1000),
          });
          if (check.status === 401) { stopped = true; break; } // A new owner already replaced this instance.
        } catch (error) {
          if (['ECONNREFUSED', 'ConnectionRefused'].includes(error.code) || error.cause?.code === 'ECONNREFUSED') { stopped = true; break; }
        }
      }
      if (!stopped) throw new Error('Supervisor stop not confirmed; inspect status before starting another instance');
      console.log('GUI and supervisor stopped.');
    }
  } else if (action === 'start') {
    const { loadConfig } = await import('../src/context.mjs');
    const { startSupervisor } = await import('../src/gui-supervisor.mjs');
    const config = await loadConfig();
    const port = config.gui?.port || 8090;
    const configuredHost = config.gui?.host || '127.0.0.1';
    const host = ['0.0.0.0', '::'].includes(configuredHost) ? '127.0.0.1' : configuredHost;
    const token = process.env[config.gui?.authTokenEnv || 'GUI_TOKEN'];
    const supervisor = await startSupervisor({
      directory, cwd: ROOT, command: [process.execPath, '--env-file=.env', 'src/cli.mjs', 'gui'],
      healthUrl: `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/liveness`,
      headers: token ? { Authorization: `Bearer ${token}` } : {}, controlPort: port + 1,
    });
    console.log(`GUI supervisor started (PID ${process.pid}). Use bun run gui:status / gui:stop. Logs: ${directory}`);
    await supervisor.done;
  } else throw new Error('Use start, status or stop');
} catch (error) {
  lifecycle.fail(error, 'supervisor_command_failure');
  console.error('Supervisor command failed. Check data/lifecycle and data/supervisor; ensure no other supervisor owns the control port.');
  process.exit(1);
}
