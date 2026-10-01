export const NVIDIA_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
export function brainApiKeyEnv(config) {
  return config?.brain?.apiKeyEnv || (config?.brain?.provider === 'nvidia' ? 'NVIDIA_API_KEY' : 'GEMINI_API_KEY');
}

export class NvidiaError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'NvidiaError'; this.code = code; this.details = details; }
}
const invalid = () => new NvidiaError('INVALID_MODEL_OUTPUT', 'NVIDIA returned malformed or incomplete output.');

// Reject truncated/empty responses before any proposed tool call can execute.
export function validateNvidiaCompletion(body) {
  if (!Array.isArray(body?.choices) || body.choices.length !== 1) throw invalid();
  const choice = body.choices[0], message = choice?.message;
  if (!['stop', 'tool_calls'].includes(choice?.finish_reason) || message?.role !== 'assistant' ||
      message.content != null && typeof message.content !== 'string' || message.audio || message.refusal) throw invalid();
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 100) throw invalid();
  const ids = new Set();
  for (const call of calls) {
    if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
        typeof call.function?.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(call.function.name) || typeof call.function.arguments !== 'string') throw invalid();
    ids.add(call.id);
  }
  if (!calls.length && (!message.content?.trim() || choice.finish_reason === 'tool_calls')) throw invalid();
  return body;
}

export async function requestNvidia({ apiKey, body, signal, fetchImpl = fetch }) {
  if (!apiKey) throw new NvidiaError('MISSING_CREDENTIALS', 'The configured NVIDIA API key is missing.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body?.model) || body.stream === true)
    throw new NvidiaError('INVALID_CONFIG', 'Invalid NVIDIA model or streaming setting.');
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  bounded.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(NVIDIA_ENDPOINT, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ ...body, stream: false }), signal: bounded });
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw new NvidiaError(bounded.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', bounded.aborted ? 'NVIDIA exceeded its request deadline.' : 'NVIDIA could not be reached.');
  }
  // Do not retain provider error bodies: they may echo credentials or inputs.
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw new NvidiaError('PROVIDER_ERROR', 'NVIDIA rejected the request.', { httpStatus: response.status });
  }
  let completion;
  try { completion = await response.json(); } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw invalid();
  }
  bounded.throwIfAborted();
  return validateNvidiaCompletion(completion);
}
