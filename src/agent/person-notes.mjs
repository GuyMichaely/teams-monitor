import { AgentRuntimeError } from './errors.mjs';

const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const MAX_NAME = 200;
const MAX_NOTE = 16000;
const MAX_MEMBERS = 100;

export function validatePersonName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_NAME)
    throw new AgentRuntimeError('INVALID_INPUT', 'Person name must be 1–200 characters.');
  return value.trim();
}

export function validatePersonNote(value) {
  if (typeof value !== 'string' || value.length > MAX_NOTE)
    throw new AgentRuntimeError('INVALID_INPUT', 'Person note must be at most 16000 characters.');
  return value;
}

export function validateChatMembers(chat, values) {
  if (typeof chat !== 'string' || !chat.trim() || chat.length > 300)
    throw new AgentRuntimeError('INVALID_INPUT', 'Chat name must be exact and at most 300 characters.');
  if (!Array.isArray(values) || values.length > MAX_MEMBERS)
    throw new AgentRuntimeError('INVALID_INPUT', 'Membership must be a list of up to 100 exact names.');
  const members = [], seen = new Set();
  for (const raw of values) {
    const name = validatePersonName(raw), key = normalize(name);
    if (!seen.has(key)) { seen.add(key); members.push(name); }
  }
  return { chat: chat.trim(), members };
}

// Membership is only used when explicitly stored for the exact chat. Never
// infer it from message authors, who are merely the observed speakers.
export function personNoteSnapshot(store, { chatName, authorName } = {}) {
  const author = typeof authorName === 'string' && authorName.trim() ? store.personNote(authorName) : null;
  const membership = typeof chatName === 'string' && chatName.trim() ? store.chatMembers(chatName) : null;
  const groupMembers = (membership?.members || [])
    .filter(name => !authorName || normalize(name) !== normalize(authorName))
    .map(name => store.personNote(name))
    .filter(person => person?.note);
  return {
    author: author?.note ? { name: author.name, note: author.note } : null,
    groupMembers,
    membership: membership ? { source: membership.source, members: membership.members } : { source: 'unavailable', members: [] },
  };
}
