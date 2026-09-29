import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, ROOT } from './local-paths.mjs';

export const processRunId = process.env.TEAMS_MONITOR_RUN_ID || randomUUID();

// Only our named files/directories are eligible; never rotate application state.
export function retainNewest(directory, pattern, keep) {
  mkdirSync(directory, { recursive: true });
  const entries = readdirSync(directory).filter(name => pattern.test(name))
    .map(name => ({ name, time: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const { name } of entries.slice(keep)) rmSync(join(directory, name), { recursive: true, force: true });
}

export function boundedWriter(path, maxBytes = 256 * 1024, copies = 2) {
  mkdirSync(join(path, '..'), { recursive: true });
  let size = existsSync(path) ? statSync(path).size : 0;
  return (value, durable = false) => {
    const bytes = Buffer.from(value);
    for (let offset = 0; offset < bytes.length;) {
      if (size >= maxBytes || (size > 0 && bytes.length <= maxBytes && size + bytes.length > maxBytes)) {
        rmSync(`${path}.${copies}`, { force: true });
        for (let i = copies - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        if (existsSync(path)) renameSync(path, `${path}.1`);
        size = 0;
      }
      const part = bytes.subarray(offset, offset + Math.min(maxBytes - size, bytes.length - offset));
      const fd = openSync(path, 'a');
      try { appendFileSync(fd, part); if (durable) fsyncSync(fd); } finally { closeSync(fd); }
      size += part.length;
      offset += part.length;
    }
  };
}

// Error messages can embed Teams content, URLs or credentials. Keep type/code and
// call sites, not arbitrary error messages or source-code excerpts.
export function errorEvidence(error) {
  return {
    type: /^[A-Za-z]+Error$/.test(error?.name) ? error.name : 'Error',
    code: /^[A-Z][A-Z0-9_]{1,50}$/.test(error?.code) ? error.code : undefined,
    stack: String(error?.stack || '').split('\n').filter(line => /^\s+at /.test(line))
      .map(line => line.replace(/\([^)]*\)/g, value => /:\d+:\d+\)$/.test(value) ? value : '(omitted)')).slice(0, 30),
  };
}

export function installLifecycle(role, { signals = false } = {}) {
  const directory = process.env.TEAMS_MONITOR_RUN_DIR || join(DATA_DIR, 'lifecycle');
  if (!process.env.TEAMS_MONITOR_RUN_DIR) retainNewest(directory, /^run-[\w-]+\.jsonl(?:\.[12])?$/, 27);
  const write = boundedWriter(join(directory, `run-${processRunId}.jsonl`));
  const started = Date.now();
  let fatal = false;
  const record = (kind, details = {}, durable = false) => {
    try { write(JSON.stringify({ at: new Date().toISOString(), kind, role, runId: processRunId, pid: process.pid, ...details }) + '\n', durable); }
    catch { try { process.stderr.write('Lifecycle diagnostics could not be persisted.\n'); } catch {} }
  };
  const fail = (error, origin = 'fatal') => {
    if (!fatal) { fatal = true; record(origin, errorEvidence(error), true); }
  };
  let revision = null;
  try { revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 2000, windowsHide: true, encoding: 'utf8' }).stdout?.trim() || null; } catch {}
  let version = null;
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch {}
  record('started', { parentPid: process.ppid, revision, version, runtime: process.versions.bun || process.version });
  process.on('uncaughtException', error => { fail(error, 'uncaught_exception'); process.exit(1); });
  process.on('unhandledRejection', error => { fail(error, 'unhandled_rejection'); process.exit(1); });
  if (signals) for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => { record('signal_received', { signal }, true); process.exit(code); });
  }
  process.on('exit', code => record('exited', { code, fatal, uptimeMs: Date.now() - started }, true));
  return { record, fail };
}
