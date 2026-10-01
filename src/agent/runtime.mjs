import { randomUUID } from 'node:crypto';
import { Agent, Runner, tool, setTracingDisabled, setTraceProcessors, setSensitiveDataLoggingEnabled } from '@openai/agents';
import { configuredModel } from './gemini-model.mjs';
import { AgentRuntimeError, failure } from './errors.mjs';
import { recordAgentActivity } from './activity.mjs';
import { errorEvidence } from '../process-diagnostics.mjs';

// No SDK exporter or sensitive SDK console logging; diagnostics stay local.
setTracingDisabled(true);
setTraceProcessors([]);
setSensitiveDataLoggingEnabled(false);
const ownTools = new WeakSet();

export function agentTool({ execute, ...definition }) {
  const result = tool({
    ...definition,
    // SDK pre-execution validation uses errorFunction only for structured tools.
    outputSchema: { type: 'object', additionalProperties: true },
    errorFunction: () => ({ ok: false, error: { code: 'INVALID_TOOL_CALL', message: 'Tool input or execution failed.' } }),
    async execute(args, runContext, details) {
      const context = runContext.context;
      if (!context?.active() || context.signal.aborted) return failure(null, { aborted: true });
      try {
        const value = await execute(args, { signal: context.signal, runId: context.runId }, details);
        if (!context.active() || context.signal.aborted) return failure(null, { aborted: true });
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { ok: true, value };
      } catch (error) { return failure(error, { aborted: context.signal.aborted }); }
    },
  });
  ownTools.add(result);
  return result;
}

export async function runAgent({ config, input, instructions = '', tools = [], model, modelSettings = {}, timeoutMs = 30000, maxTurns = 10, signal, onActivity } = {}) {
  const runId = randomUUID(), started = Date.now(), controller = new AbortController();
  let timer, timedOut = false, finished = false;
  const log = (kind, details = {}) => {
    if (finished) return;
    const event = { at: new Date().toISOString(), runId, kind, ...details };
    recordAgentActivity(event);
    try { Promise.resolve(onActivity?.(event)).catch(() => {}); } catch {}
  };
  const abort = () => controller.abort();
  log('run_started', { provider: model ? 'custom' : config?.brain?.provider || 'gemini' });
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)
      throw new AgentRuntimeError('INVALID_CONFIG', 'Invalid agent deadline or model-turn limit.');
    if (!Array.isArray(tools) || tools.some(t => !ownTools.has(t))) throw new AgentRuntimeError('INVALID_CONFIG', 'Agent tools must be created with agentTool.');
    if (typeof input !== 'string' && !Array.isArray(input)) throw new AgentRuntimeError('INVALID_INPUT', 'Agent input must be text or a history array.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    controller.signal.throwIfAborted();
    const selected = model || configuredModel(config);
    const guardedModel = {
      async getResponse(request) {
        controller.signal.throwIfAborted();
        log('model_started');
        const response = await selected.getResponse(request);
        controller.signal.throwIfAborted();
        log('model_completed', { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens });
        return response;
      },
      async *getStreamedResponse() { throw new AgentRuntimeError('UNSUPPORTED_MODEL_FEATURE', 'Streaming is not enabled.'); },
    };
    const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false, modelSettings: { retry: { maxRetries: 0 } }, toolExecution: { maxFunctionToolConcurrency: 1 } });
    runner.on('agent_tool_start', (_ctx, _agent, t, details) => log('tool_started', { tool: t.name, callId: details.toolCall.callId }));
    runner.on('agent_tool_end', (_ctx, _agent, t, _result, details) => log('tool_completed', { tool: t.name, callId: details.toolCall.callId }));
    const agent = new Agent({ name: 'TM', instructions, model: guardedModel, modelSettings, tools });
    const context = { runId, signal: controller.signal, active: () => !finished && !controller.signal.aborted };
    // A non-cooperative provider/tool cannot keep the policy waiting indefinitely.
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Run aborted')), { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    });
    const result = await Promise.race([runner.run(agent, input, { maxTurns, signal: controller.signal, context }), cancelled]);
    if (result.interruptions.length) throw new AgentRuntimeError('INVALID_MODEL_OUTPUT', 'Agent run stopped before completion.');
    log('run_completed', { durationMs: Date.now() - started, modelTurns: result.rawResponses.length });
    return { ok: true, runId, output: result.finalOutput, history: result.history, usage: result.state.usage };
  } catch (error) {
    const result = failure(error, { aborted: controller.signal.aborted, timedOut });
    log('run_failed', { durationMs: Date.now() - started, error: result.error, fault: errorEvidence(error) });
    return { ...result, runId };
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
