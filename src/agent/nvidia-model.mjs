import { OpenAIChatCompletionsModel } from '@openai/agents';
import { requestNvidia, NvidiaError, NVIDIA_MODEL } from '../nvidia-api.mjs';
import { AgentRuntimeError } from './errors.mjs';

const unsupported = () => new AgentRuntimeError('UNSUPPORTED_MODEL_FEATURE', 'This NVIDIA adapter supports text and function tools only.');
function portableInput(input) {
  if (!Array.isArray(input)) return input;
  // Keep portable history; provider-specific parts/signatures are not API fields.
  return input.filter(item => item.type !== 'reasoning' || item.rawContent?.some(p => typeof p.text === 'string')).map(({ providerData, ...item }) => ({
    ...item, ...(Array.isArray(item.content) ? { content: item.content.map(({ providerData, ...part }) => part) } : {}),
  }));
}

export class NvidiaModel {
  #sdk;
  constructor({ model = NVIDIA_MODEL, apiKey, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new AgentRuntimeError('MISSING_CREDENTIALS', 'The configured NVIDIA API key is missing.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new AgentRuntimeError('INVALID_CONFIG', 'Invalid NVIDIA model name.');
    this.model = model;
    // SDK owns protocol conversion; shared built-in HTTPS transport owns validation,
    // deadlines and sanitized failures. No second HTTP client/retry layer.
    const client = { baseURL: 'https://integrate.api.nvidia.com/v1', chat: { completions: {
      create: (body, options) => requestNvidia({ apiKey, body, signal: options?.signal, fetchImpl }),
    } } };
    this.#sdk = new OpenAIChatCompletionsModel(client, model, { strictFeatureValidation: true });
  }
  async getResponse(request) {
    request.signal?.throwIfAborted();
    if (request.previousResponseId || request.conversationId || request.prompt || request.handoffs?.length || request.outputType !== 'text' || request.tools?.some(t => t.type !== 'function' || t.namespace || t.deferLoading)) throw unsupported();
    try {
      const response = await this.#sdk.getResponse({ ...request, input: portableInput(request.input),
        // Output validation still runs locally; Chat Completions cannot declare it.
        tools: request.tools?.map(({ outputSchema, ...tool }) => tool),
        modelSettings: { ...request.modelSettings, maxTokens: request.modelSettings?.maxTokens ?? 2048, parallelToolCalls: false },
      });
      request.signal?.throwIfAborted();
      return response;
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error instanceof AgentRuntimeError) throw error;
      if (error instanceof NvidiaError) throw new AgentRuntimeError(error.code, error.message, error.details);
      if (error?.name === 'UserError') throw unsupported();
      throw new AgentRuntimeError('INVALID_MODEL_OUTPUT', 'NVIDIA returned an unsupported or invalid response.');
    }
  }
  async *getStreamedResponse() { throw unsupported(); }
}
