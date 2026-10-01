import { validateAutomation } from '../deterministic-rules.mjs';

const READ_TOOLS = [
  'list_conversations', 'read_conversation', 'search_conversations',
  'list_notes', 'read_note', 'search_notes',
];

function js(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Convert a validated automation mapping into standalone policy module source once. */
export function convertAutomationToPolicy(rawAutomation = {}, { mentionNames = [], ignoreAuthors = [] } = {}) {
  const automation = validateAutomation(rawAutomation);
  const names = Array.isArray(mentionNames) ? mentionNames.filter(x => typeof x === 'string' && x.trim()) : [];
  const ignored = Array.isArray(ignoreAuthors) ? ignoreAuthors.filter(x => typeof x === 'string' && x.trim()) : [];
  return `// One-time conversion from automation YAML. Edit this JavaScript policy directly after conversion.
const RULES = ${js(automation.rules)};
const INITIATE = ${js(automation.agent.initiate)};
const TIMEOUT_MS = ${automation.agent.timeoutMs};
const MENTION_NAMES = ${js(names)};
const IGNORED_AUTHORS = ${js(ignored)};
const READ_TOOLS = ${js(READ_TOOLS)};
const norm = value => String(value ?? '').trim().toLowerCase().replace(/\\s+/g, ' ');
const esc = value => value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
const isReaction = message => Boolean(message?.reaction);
const configuredMentions = ctx => Array.isArray(ctx.mentionNames) ? ctx.mentionNames : MENTION_NAMES;
const configuredIgnored = ctx => Array.isArray(ctx.ignoreAuthors) ? ctx.ignoreAuthors : IGNORED_AUTHORS;
function mentionMatch(message, ctx) {
  if (isReaction(message)) return false;
  const targets = configuredMentions(ctx).map(norm).filter(Boolean).map(value => value.replace(/^@\\s*/, ''));
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  const semantic = mentions.some(value => targets.includes(norm(value).replace(/^@\\s*/, '')));
  const text = norm(message?.text);
  const explicit = targets.some(name => new RegExp('(^|[^\\\\p{L}\\\\p{N}_@])@' + esc(name) + '(?![\\\\p{L}\\\\p{N}_])', 'u').test(text));
  return semantic || explicit;
}
function eligible(message, ctx) {
  const author = norm(message?.author);
  const self = !author || author === 'you' || configuredMentions(ctx).map(norm).includes(author);
  return !self && !configuredIgnored(ctx).map(norm).includes(author);
}
function evaluate(condition, ctx) {
  const message = ctx.message ?? ctx.latest ?? {};
  if (condition.all || condition.any) {
    const key = condition.all ? 'all' : 'any';
    const children = condition[key].map(child => evaluate(child, ctx));
    const matched = key === 'all' ? children.every(item => item.matched) : children.some(item => item.matched);
    return { type: key, matched, conditions: children };
  }
  if (condition.type === 'direct_message') {
    const chat = ctx.chatName ?? ctx.chat ?? '';
    const author = message?.author ?? '';
    const identityMatch = Boolean(norm(chat) && norm(author) && norm(chat) === norm(author));
    const matched = eligible(message, ctx) && !isReaction(message) && identityMatch;
    return { type: 'direct_message', matched, input: { chat, author }, normalized: { chat: norm(chat), author: norm(author) }, comparisons: { chatEqualsAuthor: identityMatch } };
  }
  if (condition.type === 'mention') {
    const matched = eligible(message, ctx) && mentionMatch(message, ctx);
    return { type: 'mention', matched, input: { author: message?.author ?? '', text: message?.text ?? '', mentions: message?.mentions ?? [], mentionNames: configuredMentions(ctx) } };
  }
  if (condition.type === 'reaction') return { type: 'reaction', matched: isReaction(message) && !configuredIgnored(ctx).map(norm).includes(norm(message?.author)), input: message?.reaction ?? null };
  const actualValue = condition.field === 'chat' ? (ctx.chatName ?? ctx.chat ?? '') : (message?.[condition.field] ?? '');
  const actual = String(actualValue), expected = norm(condition.value), normalized = norm(actual);
  let matched;
  if (condition.match === 'exact') matched = normalized === expected;
  else if (condition.match === 'contains') matched = normalized.includes(expected);
  else {
    const tokens = normalized.match(/(?<![\\p{L}\\p{N}_.])\\d+(?:\\.\\d+)?(?![\\p{L}\\p{N}_]|\\.\\d)/gu) || [];
    matched = tokens.includes(expected);
  }
  return { type: 'textual', field: condition.field, match: condition.match, matched, input: { actual, expected: condition.value }, normalized: { actual: normalized, expected } };
}
const fingerprint = action => JSON.stringify(action);
const failure = error => ({ ok: false, error: { code: 'ACTION_FAILED', message: String(error?.message ?? error ?? 'Action failed') } });
async function callAction(fn, ...args) { try { return await fn(...args); } catch (error) { return failure(error); } }

export async function handle(ctx = {}, actions = {}) {
  const message = ctx.message ?? ctx.latest ?? {};
  const chat = ctx.chatName ?? ctx.chat ?? '';
  const author = ctx.authorName ?? message.author ?? '';
  if (ctx.notifyAll) return actions.alert({ chat, author, text: message.text || '', time: message.time });
  const evaluations = RULES.filter(rule => rule.enabled).map(rule => {
    const evidence = evaluate(rule.when, ctx);
    return { ruleId: rule.id, matched: evidence.matched, action: rule.action, permissions: rule.agent, evidence };
  });
  const groups = new Map();
  for (const item of evaluations.filter(item => item.matched && item.action.type !== 'ignore')) {
    const effective = item.action.type === 'alert_phone'
      ? { type: item.action.type, text: item.action.text || message.text || '' }
      : item.action;
    const key = fingerprint(effective);
    const group = groups.get(key) ?? { action: item.action, effective, ruleIds: [], cancel: true, modify: true, handle: null, result: null };
    group.ruleIds.push(item.ruleId);
    // A deduped action shared by rules is editable only when every contributing
    // rule grants that permission; sharing cannot widen any rule's authority.
    group.cancel &&= item.permissions.cancel;
    group.modify &&= item.permissions.modify;
    groups.set(key, group);
  }
  const proposals = [];
  for (const group of groups.values()) {
    const result = group.action.type === 'reply'
      ? await callAction(actions.sendMessage, chat, group.action.text)
      : await callAction(actions.alert, { chat, author, text: group.effective.text, time: message.time });
    group.result = result;
    group.handle = result?.ok && typeof result.id === 'string' ? result.id : null;
    proposals.push({ ruleIds: group.ruleIds, action: group.action, effectiveAction: group.effective, result, permissions: { cancel: group.cancel, modify: group.modify } });
  }

  const initiationAllowed = INITIATE.when === 'always' || (INITIATE.when === 'unmatched' && evaluations.every(item => !item.matched));
  const initiateActions = initiationAllowed ? INITIATE.actions.map(type => type === 'reply' ? 'message' : 'alert') : [];
  const cancelIds = [...groups.values()].filter(group => group.handle && group.cancel).map(group => group.handle);
  const modifyIds = Object.fromEntries([...groups.values()].filter(group => group.handle && group.modify && group.action.type !== 'ignore').map(group => [group.handle, ['text']]));
  const hasReview = cancelIds.length || Object.keys(modifyIds).length || initiateActions.length;
  let review = null;
  if (hasReview && typeof actions.llm === 'function') {
    const tools = [...READ_TOOLS];
    if (cancelIds.length) tools.push('cancel_action');
    if (Object.keys(modifyIds).length) tools.push('modify_action');
    if (initiateActions.includes('message')) tools.push('send_message');
    if (initiateActions.includes('alert')) tools.push('alert');
    const prompt = [
      'Review this JavaScript policy evaluation. Preserve deterministic actions unless you have explicit permission to cancel or change text. You may not change an action type or destination. New messages and alerts are allowed only when explicitly listed in initiateActions. Global send permission is still enforced by the action API.',
      JSON.stringify({ evaluations, proposals, input: { message, chatName: chat, authorName: author, isDM: !!ctx.isDM, mentionsMe: !!ctx.mentionsMe, history: ctx.history ?? [], userProfile: ctx.userProfile ?? '' }, permissions: { cancelIds, modifyIds, initiateActions } }),
    ].join('\\n');
    const options = { timeoutMs: TIMEOUT_MS, tools, readChats: [chat], writeChats: initiateActions.includes('message') ? [chat] : [], cancelIds, modifyIds, initiateActions };
    try { review = await actions.llm(prompt, options); }
    catch (error) { review = failure(error); }
  }
  return { ok: true, evaluations, proposals, review, permissions: { cancelIds, modifyIds, initiateActions } };
}
`;
}

/** Parse YAML with Bun's built-in parser, then return the generated module source. */
export function convertAutomationYamlToPolicy(yaml, options = {}) {
  if (typeof Bun === 'undefined' || !Bun.YAML) throw new Error('Bun.YAML is required to parse automation YAML');
  const parsed = Bun.YAML.parse(yaml);
  return convertAutomationToPolicy(parsed, options);
}
