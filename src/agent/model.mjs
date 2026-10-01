import { GeminiModel } from './gemini-model.mjs';
import { NvidiaModel } from './nvidia-model.mjs';
import { brainApiKeyEnv } from '../nvidia-api.mjs';
import { AgentRuntimeError } from './errors.mjs';

export function configuredModel(config, options = {}) {
  const b = config?.brain || {}, provider = b.provider || 'gemini';
  const Model = provider === 'gemini' ? GeminiModel : provider === 'nvidia' ? NvidiaModel : null;
  if (!Model) throw new AgentRuntimeError('INVALID_CONFIG', 'Unsupported agent model provider.');
  return new Model({ model: b.model, apiKey: process.env[brainApiKeyEnv(config)], ...options });
}
