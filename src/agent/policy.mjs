import { mkdir, readFile, writeFile, rename, unlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LOCAL_HOME, ROOT } from '../local-paths.mjs';
import { loadConfig } from '../context.mjs';
import { operationQueue } from '../teams-queue.mjs';
import { blankPlan, actionAPI } from './plan.mjs';
import { agentReview } from './tools.mjs';
import { AgentRuntimeError, failure } from './errors.mjs';

export const POLICY_FILE = join(LOCAL_HOME, 'automation', 'policy.ts');
const worker = join(ROOT, 'src', 'agent', 'policy-worker.mjs');
const queue = operationQueue();
const versionOf = source => createHash('sha256').update(source).digest('hex');

export async function policySubprocess({ path, context, handler = 'handle', validate = false, dispatch, timeoutMs = 90000, signal }) {
  const child = Bun.spawn([process.execPath, '--no-env-file', worker], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const nonce = randomUUID(), prefix = 'TM_RPC:' + nonce + ':', decoder = new TextDecoder();
  let finished = false, timer, bytes = 0;
  const stop = () => { try { child.kill(); } catch {} };
  const send = value => { if (!finished) { child.stdin.write(JSON.stringify(value) + '\n'); child.stdin.flush(); } };
  // Never buffer arbitrary console output/source excerpts from trusted local code.
  const drain = async stream => { for await (const _ of stream) {} };
  const err = drain(child.stderr).catch(() => {});
  try {
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) throw new AgentRuntimeError('CANCELLED', 'Policy was cancelled.');
    timer = setTimeout(stop, timeoutMs);
    send({ type: 'start', path, context, handler, validate, nonce });
    let buffer = '', calls = 0, result;
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > 2_000_000) { stop(); break; }
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.startsWith(prefix)) continue;
        const item = JSON.parse(line.slice(prefix.length));
        if (item.type === 'done') { result = item; break; }
        if (item.type === 'call') {
          if (++calls > 200) { stop(); break; }
          let output;
          try { output = await dispatch(item.method, item.args); } catch (error) { output = failure(error); }
          if (signal?.aborted) stop(); else send({ type: 'reply', id: item.id, result: output });
        }
      }
      if (result) return result;
    }
    return { ok: false, error: { code: signal?.aborted ? 'CANCELLED' : 'POLICY_TIMEOUT', message: 'Policy did not complete within its bounded execution window.' } };
  } catch (error) { return failure(error); }
  finally { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); stop(); await child.exited; await err; }
}

export async function savePolicy(source, path = POLICY_FILE) {
  return queue.run(async () => {
    if (typeof source !== 'string' || !source.trim() || source.length > 100000) throw new AgentRuntimeError('INVALID_POLICY', 'Policy must be TypeScript source up to 100000 characters.');
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID() + '.ts';
    try {
      await writeFile(temp, source, { flag: 'wx' });
      const result = await policySubprocess({ path: temp, validate: true, timeoutMs: 3000 });
      if (!result.ok) throw new AgentRuntimeError('INVALID_POLICY', 'Policy syntax/exports validation failed or timed out. Active policy unchanged.', { locations: result.error?.locations });
      await rename(temp, path);
      return { source, version: versionOf(source) };
    } finally { await unlink(temp).catch(() => {}); }
  });
}

export async function ensurePolicy() {
  if (LOCAL_HOME !== ROOT) {
    await mkdir(dirname(POLICY_FILE), { recursive: true });
    await copyFile(join(ROOT, 'automation', 'policy-api.d.ts'), join(dirname(POLICY_FILE), 'policy-api.d.ts'));
  }
  if (!existsSync(POLICY_FILE)) {
    const source = await readFile(join(ROOT, 'automation', 'policy.example.ts'), 'utf8');
    await savePolicy(source);
  }
  const source = await readFile(POLICY_FILE, 'utf8');
  return { source, version: versionOf(source) };
}

export async function evaluatePolicy(context, { store, configLoader = loadConfig, signal, model, replay = false, handler = 'handle', savedCeiling } = {}) {
  const runId = randomUUID(), plan = blankPlan();
  const cancellation = new AbortController();
  let cancelWatch;
  const { source, version } = await ensurePolicy();
  // Freeze source per handler, including while a dashboard save activates the next version.
  const snapshot = POLICY_FILE + '.' + runId + '.ts';
  await writeFile(snapshot, source, { flag: 'wx' });
  try {
  store.record(runId, 'policy_input', { handler, context, version, source, replay });
  store.current({ runId, trigger: context.trigger, conversationId: null, startedAt: new Date().toISOString() });
  cancelWatch = setInterval(() => { if (store.runCancelled(runId)) cancellation.abort(); }, 100);
  const { api } = actionAPI({ plan, context, configLoader, store, bounded: savedCeiling,
    llm: (prompt, options) => replay && !model ? Promise.resolve({ ok: false, error: { code: 'REPLAY_MODEL_DISABLED', message: 'Replay stages deterministic actions only; model and external effects are disabled.' } }) :
      agentReview({ prompt, options, context, source, version, plan, store, configLoader, signal: policySignal, model, savedCeiling, replay }) });
  const config = await configLoader();
  const timeoutMs = Math.min(300000, Math.max(1000, config.agent?.policyTimeoutMs || 90000));
  const policySignal = AbortSignal.any([cancellation.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    const result = await policySubprocess({ path: snapshot, context, handler, signal: policySignal, timeoutMs,
      dispatch: (name, args) => { if (!Object.hasOwn(api, name) || !Array.isArray(args)) throw new AgentRuntimeError('INVALID_ACTION', 'Unknown policy action.'); return api[name](...args); } });
    if (!result.ok || policySignal.aborted) {
      const failed = cancellation.signal.aborted ? { ok: false, error: { code: 'CANCELLED', message: 'Run cancelled; uncommitted proposals and history discarded.' } } :
        policySignal.aborted && !signal?.aborted ? { ok: false, error: { code: 'POLICY_TIMEOUT', message: 'Policy exceeded its bounded execution window.' } } : result.ok ? failure(null, { aborted: true }) : result;
      store.record(runId, 'policy_failed', { ...failed, version });
      return { ...failed, runId, version };
    }
    return { ok: true, runId, version, ...plan, value: result.value, replay };
  } finally { clearInterval(cancelWatch); try { if (store.current()?.runId === runId) store.current(null); } finally { await unlink(snapshot).catch(() => {}); } }
}
