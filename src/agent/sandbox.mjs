import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, ROOT } from '../local-paths.mjs';
import { sandboxLimits } from './sandbox-limits.mjs';
import { AgentRuntimeError, failure } from './errors.mjs';

const nativeSource = join(ROOT, 'scripts', 'windows', 'BunSandbox.cs');
export const SANDBOX_DIRECTORY = join(DATA_DIR, 'agent', 'sandbox');
export const SANDBOX_HELPER = join(SANDBOX_DIRECTORY, 'TM-sandbox.exe');
export function sandboxStatus() {
  const backend = 'windows_lpac';
  if (process.platform !== 'win32' || process.arch !== 'x64') return { available: false, backend, reason: 'Native sandbox currently supports Windows x64 only.' };
  if (!existsSync(SANDBOX_HELPER)) return { available: false, backend, reason: 'Run bun run sandbox:build in the agentic checkout.' };
  try {
    const hash = createHash('sha256').update(readFileSync(nativeSource)).digest('hex');
    if (readFileSync(SANDBOX_HELPER + '.sha256', 'utf8').trim().toLowerCase() !== hash) throw Error();
    return { available: true, backend, reason: 'Native helper built. Launch restrictions are verified for each execution.' };
  } catch { return { available: false, backend, reason: 'Sandbox helper is stale; run bun run sandbox:build.' }; }
}

export async function executeSandbox({ code, context = {}, input = null, tools = [], dispatch, limits, signal, onActivity = () => {} }) {
  let child, timer, closed = false, stopped = false, stopReason, ready, terminal, exit, stderr = '', log = '', bytes = 0, calls = 0;
  const settings = sandboxLimits(limits);
  const controller = new AbortController();
  const guestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let releaseStop;
  const stoppedPromise = new Promise(resolve => { releaseStop = resolve; });
  const stop = reason => {
    if (stopped) return;
    stopped = true; stopReason = reason;
    controller.abort(); releaseStop({ ok: false, error: { code: reason, message: 'Sandbox bridge was cancelled.' } });
    // EOF requests native job termination; a bounded hard kill also closes its job handle.
    try { child?.stdin.end(); } catch {}
    timer = setTimeout(() => { try { child?.kill(); } catch {} }, 5000);
  };
  const abort = () => stop('CANCELLED');
  const send = item => { if (!closed && !stopped) { child.stdin.write(JSON.stringify(item) + '\n'); child.stdin.flush(); } };
  const addLog = text => { log = (log + text).slice(-settings.outputBytes); };
  let outerTimer;
  try {
    const status = sandboxStatus();
    if (!status.available) throw new AgentRuntimeError('SANDBOX_UNAVAILABLE', status.reason);
    if (signal?.aborted) return failure(null, { aborted: true });
    if (typeof code !== 'string' || !code.trim() || code.length > 100000) throw new AgentRuntimeError('INVALID_INPUT', 'Invalid or oversized Bun code.');
    const start = { kind: 'start', code, context, input, tools };
    if (Buffer.byteLength(JSON.stringify(start)) > 220000) throw new AgentRuntimeError('CONTEXT_LIMIT', 'Sandbox input exceeds its limit.');
    child = Bun.spawn([SANDBOX_HELPER, join(SANDBOX_DIRECTORY, 'runs'), process.execPath, join(ROOT, 'src', 'agent', 'sandbox-worker.mjs'),
      String(settings.timeoutMs), String(settings.memoryMb), String(settings.cpuPercent), String(settings.maxProcesses), String(settings.outputBytes)],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    signal?.addEventListener('abort', abort, { once: true });
    outerTimer = setTimeout(() => stop('TIMEOUT'), settings.timeoutMs + 10000); // bounded native setup/cleanup too
    const drain = (async () => { for await (const chunk of child.stderr) { stderr += Buffer.from(chunk).toString(); if (stderr.length > 4096) stop('OUTPUT_LIMIT'); } })();
    let nativeBuffer = '', guestBuffer = '';
    const guestDecoder = new TextDecoder();
    const processGuest = async data => {
      bytes += data.length;
      if (bytes > settings.outputBytes) { stop('OUTPUT_LIMIT'); return; }
      guestBuffer += guestDecoder.decode(data, { stream: true });
      let end;
      while (!stopped && (end = guestBuffer.indexOf('\n')) >= 0) {
        const line = guestBuffer.slice(0, end); guestBuffer = guestBuffer.slice(end + 1);
        let item; try { item = JSON.parse(line); } catch { addLog(line + '\n'); continue; }
        if (item?.kind === 'log') { addLog(String(item.text).slice(0, settings.outputBytes) + '\n'); continue; }
        if (terminal) { stop('INVALID_SANDBOX_OUTPUT'); break; }
        if (item?.kind === 'done' && typeof item.ok === 'boolean') { terminal = item; continue; }
        if (item?.kind !== 'call' || !Number.isSafeInteger(item.id) || item.id !== calls + 1 || ++calls > 100 || typeof item.name !== 'string') {
          stop('INVALID_SANDBOX_OUTPUT'); break;
        }
        let result;
        try {
          const operation = Promise.resolve().then(() => dispatch(item.name, item.args, guestSignal)).catch(error => failure(error));
          result = await Promise.race([operation, stoppedPromise]);
        } catch (error) { result = failure(error); }
        if (stopped) break;
        onActivity({ kind: 'sandbox_tool_result', tool: item.name, input: item.args, result });
        if (signal?.aborted) { abort(); break; }
        if (Buffer.byteLength(JSON.stringify(result)) > 65536) result = { ok: false, error: { code: 'RESULT_LIMIT', message: 'Tool result exceeds sandbox bridge limit.' } };
        send({ kind: 'reply', id: item.id, result });
      }
    };
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      nativeBuffer += decoder.decode(chunk, { stream: true });
      if (nativeBuffer.length > 600000) { stop('INVALID_SANDBOX_OUTPUT'); break; }
      let end;
      while ((end = nativeBuffer.indexOf('\n')) >= 0) {
        const item = JSON.parse(nativeBuffer.slice(0, end)); nativeBuffer = nativeBuffer.slice(end + 1);
        if (item.kind === 'ready' && !ready && item.boundary === 'windows_lpac') {
          ready = item; clearTimeout(outerTimer); outerTimer = setTimeout(() => stop('TIMEOUT'), settings.timeoutMs + 150);
          onActivity({ ...item, kind: 'sandbox_started', limits: settings }); send(start);
        }
        else if (item.kind === 'stdout' && ready) await processGuest(Buffer.from(item.data, 'base64'));
        else if (item.kind === 'stderr' && ready) { const data = Buffer.from(item.data, 'base64'); bytes += data.length; if (bytes > settings.outputBytes) stop('OUTPUT_LIMIT'); addLog(data.toString()); }
        else if (item.kind === 'exit') exit = item;
        else if (item.kind === 'cleanup_warning') onActivity({ kind: 'sandbox_cleanup_warning', resource: item.resource });
        else if (item.kind === 'error') throw new AgentRuntimeError('SANDBOX_UNAVAILABLE', 'Native sandbox could not enforce its boundary.', { stage: item.stage, win32: item.win32 });
        else { stop('INVALID_SANDBOX_OUTPUT'); break; }
      }
    }
    closed = true;
    const helperCode = await child.exited; await drain;
    if (stopReason) throw new AgentRuntimeError(stopReason, 'Sandbox execution stopped; sandbox changes discarded.');
    if (exit?.reason) throw new AgentRuntimeError(({ timeout: 'TIMEOUT', output_limit: 'OUTPUT_LIMIT' })[exit.reason] || 'SANDBOX_FAILED', 'Sandbox limit or lifecycle failure; sandbox changes discarded.');
    if (!ready || !exit || helperCode !== 0 || !terminal || (!terminal.ok && exit.code === 0)) throw new AgentRuntimeError('SANDBOX_FAILED', 'Sandbox exited without a valid result; sandbox changes discarded.');
    if (!terminal.ok) return { ok: false, error: { code: 'CODE_ERROR', message: 'Bun code failed; sandbox changes discarded.' }, output: log, boundary: ready.boundary };
    if (exit.code !== 0) throw new AgentRuntimeError('SANDBOX_FAILED', 'Sandbox process failed; sandbox changes discarded.');
    return { ok: true, result: terminal.result ?? null, output: log, boundary: ready.boundary };
  } catch (error) { return { ...failure(error), output: log }; }
  finally {
    closed = true;
    clearTimeout(timer); clearTimeout(outerTimer); signal?.removeEventListener('abort', abort);
    try { child?.stdin.end(); } catch {}
    if (child && child.exitCode === null) {
      // Prefer graceful native cleanup (profile/bundle removal) even for protocol failures.
      await Promise.race([child.exited.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) { child.kill(); await child.exited.catch(() => {}); }
    }
  }
}
