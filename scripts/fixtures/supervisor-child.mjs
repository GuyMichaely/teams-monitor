import { installLifecycle, processRunId } from '../../src/process-diagnostics.mjs';
const [, , mode, port] = process.argv;
installLifecycle('fixture', { signals: true });
if (mode === 'startup_failure') throw new Error('private payload must not enter lifecycle log');
if (mode === 'spawn_output') { console.log('stdout fixture'); console.error('stderr fixture'); }
if (mode === 'normal') process.exit(0);
let requests = 0;
Bun.serve({
  hostname: '127.0.0.1', port: Number(port),
  fetch() {
    requests++;
    if (requests === 1) {
      if (mode === 'throw') setTimeout(() => { throw new Error('private payload must not enter lifecycle log'); }, 80);
      if (mode === 'reject') setTimeout(() => { Promise.reject(new Error('private rejected payload')); }, 80);
      if (mode === 'exit') setTimeout(() => process.exit(0), 80);
      if (mode === 'signal') setTimeout(() => process.emit('SIGTERM'), 80);
    }
    if (mode === 'hang' && requests > 1) return new Promise(() => {});
    return Response.json({ ok: true, runId: processRunId, pid: process.pid });
  },
});
