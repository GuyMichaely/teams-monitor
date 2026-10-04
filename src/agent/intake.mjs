import { reactionMessages } from '../reaction-messages.mjs';
import { isMentioned } from '../deterministic-rules.mjs';
import { normalize } from './store.mjs';
import { publicMessage } from './message-view.mjs';

export const selfAuthored = (author, names = []) => normalize(author) === 'you' || names.some(name => normalize(name) === normalize(author));

// Other people's badges are available by explicit read, not pushed into policy/model context.
const contextMessage = (message, names) => {
  if (selfAuthored(message.author, names)) return publicMessage(message);
  const { reactions, ...body } = message;
  return body;
};

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
  const ownMessages = ordered.filter(message => selfAuthored(message.author, names));
  for (const message of reactionMessages(ownMessages, reactions, activatedAt, now)) {
    const id = store.observe(chat, message, true);
    if (id) ids.push(id);
  }
  return ids;
}

export function messageContext(row, store, config, userProfile) {
  const names = config.alerts?.mentionNames || [];
  const message = contextMessage(row.value, names);
  return { trigger: 'message', contextId: `chat:${normalize(row.chat)}`, messageId: row.id,
    chatName: row.chat, authorName: message.author, message,
    isDM: !message.reaction && normalize(row.chat) === normalize(message.author),
    mentionsMe: isMentioned(message, config.alerts?.mentionNames), reaction: message.reaction || null,
    history: store.history(row.chat).map(r => r.value).filter(m => m && (!m.reaction || selfAuthored(m.reaction.originalAuthor, names))).map(m => contextMessage(m, names)), userProfile,
    mentionNames: names,
    now: new Date().toISOString() };
}
