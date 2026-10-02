import { AgentRuntimeError } from './errors.mjs';

// Local history key, not the SDK's server-side OpenAI conversationId option.
export function conversationId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || value !== value.trim())
    throw new AgentRuntimeError('INVALID_INPUT', 'Conversation ID must be nonblank text up to 300 characters, without surrounding spaces.');
  return value;
}

export const sameReadScope = (a = [], b = []) => JSON.stringify([...new Set(a.map(x => x.trim().toLowerCase().replace(/\s+/g, ' ')))].sort()) ===
  JSON.stringify([...new Set(b.map(x => x.trim().toLowerCase().replace(/\s+/g, ' ')))].sort());
