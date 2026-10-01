import { randomUUID } from 'node:crypto';
import { Usage } from '@openai/agents';
import { AgentRuntimeError } from './errors.mjs';

const invalid = () => new AgentRuntimeError('INVALID_MODEL_OUTPUT', 'Gemini returned malformed or incomplete output.');
const unsupported = () => new AgentRuntimeError('UNSUPPORTED_MODEL_FEATURE', 'This Gemini adapter supports text and function tools only.');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function textParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) throw unsupported();
  return content.map(part => {
    if (!['input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string') throw unsupported();
    return { text: part.text };
  });
}

export function geminiContents(input) {
  if (typeof input === 'string') return [{ role: 'user', parts: [{ text: input }] }];
  if (!Array.isArray(input)) throw unsupported();
  const contents = [], calls = new Map();
  const append = (role, parts) => {
    if (!parts.length) return;
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const item of input) {
    const original = item.providerData?.geminiPart;
    if (item.type === 'function_call') {
      let args;
      try { args = JSON.parse(item.arguments); } catch { throw invalid(); }
      if (!object(args) || typeof item.name !== 'string' || calls.has(item.callId)) throw invalid();
      calls.set(item.callId, { name: item.name, id: original?.functionCall?.id });
      append('model', [original || { functionCall: { name: item.name, args } }]);
    } else if (item.type === 'function_call_result') {
      const call = calls.get(item.callId);
      if (!call || call.name !== item.name) throw invalid();
      let output = item.output;
      if (typeof output !== 'string') {
        if (output?.type !== 'text' || typeof output.text !== 'string') throw unsupported();
        output = output.text;
      }
      let parsed;
      try { parsed = JSON.parse(output); } catch { parsed = output; }
      append('user', [{ functionResponse: {
        name: call.name, ...(call.id ? { id: call.id } : {}), response: object(parsed) ? parsed : { output: parsed },
      } }]);
    } else if (item.type === 'reasoning' && original) {
      append('model', [original]);
    } else if ((!item.type || item.type === 'message') && ['user', 'assistant'].includes(item.role)) {
      append(item.role === 'assistant' ? 'model' : 'user', original ? [original] : textParts(item.content));
    } else throw unsupported();
  }
  return contents;
}

export function geminiRequest(request) {
  if (request.previousResponseId || request.conversationId || request.prompt || request.handoffs?.length || request.outputType !== 'text') throw unsupported();
  const settings = request.modelSettings || {}, tools = request.tools || [];
  if (tools.some(t => t.type !== 'function' || t.namespace || !object(t.parameters))) throw unsupported();
  const body = { contents: geminiContents(request.input), generationConfig: {} };
  if (request.systemInstructions) body.systemInstruction = { parts: [{ text: request.systemInstructions }] };
  if (settings.temperature !== undefined) body.generationConfig.temperature = settings.temperature;
  if (settings.topP !== undefined) body.generationConfig.topP = settings.topP;
  if (settings.maxTokens !== undefined) body.generationConfig.maxOutputTokens = settings.maxTokens;
  if (tools.length) {
    body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
    const choice = settings.toolChoice || 'auto';
    const mode = choice === 'auto' ? 'AUTO' : choice === 'none' ? 'NONE' : 'ANY';
    if (!['auto', 'none', 'required'].includes(choice) && !tools.some(t => t.name === choice)) throw unsupported();
    body.toolConfig = { functionCallingConfig: { mode, ...(!['auto', 'none', 'required'].includes(choice) ? { allowedFunctionNames: [choice] } : {}) } };
  }
  return body;
}

export function geminiResponse(body) {
  const candidate = body?.candidates?.[0];
  if (!candidate || candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw invalid();
  const output = [], ids = new Set();
  for (const part of candidate.content.parts) {
    if (!object(part)) throw invalid();
    const providerData = { geminiPart: part };
    if (part.functionCall) {
      const call = part.functionCall, callId = call.id || randomUUID();
      if (typeof call.name !== 'string' || !call.name || !object(call.args ?? {}) || typeof callId !== 'string' || ids.has(callId)) throw invalid();
      ids.add(callId);
      output.push({ type: 'function_call', callId, name: call.name, arguments: JSON.stringify(call.args ?? {}), providerData });
    } else if (typeof part.text === 'string') {
      if (part.thought) output.push({ type: 'reasoning', content: [], providerData });
      else output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: part.text }], providerData });
    } else throw unsupported();
  }
  if (!output.some(item => item.type === 'function_call' || item.type === 'message' && item.content.some(p => p.text.trim()))) throw invalid();
  const u = body.usageMetadata || {};
  return {
    output,
    usage: new Usage({ requests: 1, inputTokens: u.promptTokenCount || 0, outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), totalTokens: u.totalTokenCount || 0 }),
  };
}

export class GeminiModel {
  #apiKey;
  #fetch;
  constructor({ model = 'gemini-3.1-flash-lite', apiKey, fetchImpl = fetch } = {}) {
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new AgentRuntimeError('INVALID_CONFIG', 'Invalid Gemini model name.');
    if (!apiKey) throw new AgentRuntimeError('MISSING_CREDENTIALS', 'The configured Gemini API key is missing.');
    this.model = model;
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }
  async getResponse(request) {
    request.signal?.throwIfAborted();
    const payload = geminiRequest(request);
    let response;
    try {
      response = await this.#fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.#apiKey },
        body: JSON.stringify(payload), signal: request.signal,
      });
    } catch {
      request.signal?.throwIfAborted();
      throw new AgentRuntimeError('PROVIDER_ERROR', 'Gemini could not be reached.');
    }
    if (!response.ok) throw new AgentRuntimeError('PROVIDER_ERROR', 'Gemini rejected the request.', { httpStatus: response.status });
    let body;
    try { body = await response.json(); } catch { throw invalid(); }
    request.signal?.throwIfAborted();
    return geminiResponse(body);
  }
  async *getStreamedResponse() { throw unsupported(); }
}

export function configuredModel(config, options = {}) {
  const b = config?.brain || {};
  if ((b.provider || 'gemini') !== 'gemini') throw new AgentRuntimeError('INVALID_CONFIG', 'Only Gemini is configured for the agent SDK currently.');
  return new GeminiModel({ model: b.model, apiKey: process.env[b.apiKeyEnv || 'GEMINI_API_KEY'], ...options });
}
