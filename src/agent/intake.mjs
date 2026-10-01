import { reactionMessages } from '../reaction-messages.mjs';
import { isMentioned } from '../deterministic-rules.mjs';
import { normalize } from './store.mjs';

export const selfAuthored = (author, names = []) => normalize(author) === 'you' || names.some(name => normalize(name) === normalize(author));

export function intake({ store, chat, messages, config, activatedAt, reactions, now = new Date().toISOString() }) {
  const names = config.alerts?.mentionNames || [];
  const selfChat = selfAuthored(normalize(chat).replace(/\s*\(you\)$/, ''), names);
  const echo = config.debug?.echoLoop === true;
  const eligible = message => (echo || selfChat || !selfAuthored(message.author, names)) &&
    (echo || (Number.isFinite(Date.parse(message.time)) && Date.parse(message.time) >= Date.parse(activatedAt)));
  const ordered = [...(messages || [])].filter(m => m && typeof m.text === 'string' && typeof m.author === 'string')
    .sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0));
  const ids = [];
  for (const message of ordered) {
    const id = store.observe(chat, message, eligible(message));
    if (id) ids.push(id);
  }
  for (const message of reactionMessages(ordered, reactions, activatedAt, now)) {
    const id = store.observe(chat, message, true);
    if (id) ids.push(id);
  }
  return ids;
}

export function messageContext(row, store, config, userProfile) {
  const message = row.value;
  return { trigger: 'message', contextId: `chat:${normalize(row.chat)}`, messageId: row.id,
    chat: row.chat, chatName: row.chat, authorName: message.author, message, latest: message,
    isDM: !message.reaction && normalize(row.chat) === normalize(message.author),
    mentionsMe: isMentioned(message, config.alerts?.mentionNames), reaction: message.reaction || null,
    history: store.history(row.chat).map(r => r.value).filter(Boolean), userProfile,
    mentionNames: config.alerts?.mentionNames || [], ignoreAuthors: config.alerts?.ignoreAuthors || [],
    notifyAll: config.alerts?.notifyAll === true,
    now: new Date().toISOString(), coverage: 'Observed visible tails only; not a complete Teams archive.' };
}
