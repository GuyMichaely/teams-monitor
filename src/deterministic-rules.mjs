const ACTIONS = new Set(["alert_phone", "reply", "ignore"]);
const TEXT_FIELDS = new Set(["text", "author", "chat"]);
const TEXT_MATCHES = new Set(["exact", "contains", "contains_number"]);
const MAX_RULES = 100;
const MAX_CONDITION_DEPTH = 8;
const MAX_CONDITIONS_PER_RULE = 100;
const MAX_BRANCHES = 20;

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const normalize = value => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const ownKeys = value => Object.keys(value);

function onlyKeys(value, allowed, where) {
  for (const key of ownKeys(value)) {
    if (!allowed.has(key)) throw new Error(`${where} has unknown field: ${key}`);
  }
}

function nonemptyString(value, where) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value.trim();
}

function normalizeCondition(raw, where, depth, budget) {
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  if (depth > MAX_CONDITION_DEPTH) throw new Error(`${where} exceeds maximum condition depth ${MAX_CONDITION_DEPTH}`);
  budget.count += 1;
  if (budget.count > MAX_CONDITIONS_PER_RULE) throw new Error(`${where} exceeds maximum condition count ${MAX_CONDITIONS_PER_RULE}`);

  if (Object.hasOwn(raw, "not")) {
    onlyKeys(raw, new Set(["not"]), where);
    return { not: normalizeCondition(raw.not, `${where}.not`, depth + 1, budget) };
  }

  if (Object.hasOwn(raw, "all") || Object.hasOwn(raw, "any")) {
    const key = Object.hasOwn(raw, "all") ? "all" : "any";
    onlyKeys(raw, new Set([key]), where);
    const branches = raw[key];
    if (!Array.isArray(branches) || branches.length < 1 || branches.length > MAX_BRANCHES) {
      throw new Error(`${where}.${key} must contain 1 to ${MAX_BRANCHES} conditions`);
    }
    return { [key]: branches.map((branch, i) => normalizeCondition(branch, `${where}.${key}[${i}]`, depth + 1, budget)) };
  }

  if (["direct_message", "mention", "reaction"].includes(raw.type)) {
    onlyKeys(raw, new Set(["type"]), where);
    return { type: raw.type };
  }

  onlyKeys(raw, new Set(["field", "match", "value"]), where);
  if (!TEXT_FIELDS.has(raw.field)) throw new Error(`${where}.field must be text, author, or chat`);
  if (!TEXT_MATCHES.has(raw.match)) throw new Error(`${where}.match must be exact, contains, or contains_number`);
  const value = nonemptyString(raw.value, `${where}.value`);
  if (raw.match === "contains_number") {
    if (raw.field !== "text") throw new Error(`${where}.contains_number is only supported for text`);
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${where}.value must be an integer or decimal number`);
  }
  return { field: raw.field, match: raw.match, value };
}

export function validateDeterministicRules(rules) {
  if (!Array.isArray(rules)) throw new Error("automation.rules must be an array");
  if (rules.length > MAX_RULES) throw new Error(`automation.rules may contain at most ${MAX_RULES} rules`);
  const ids = new Set();
  return rules.map((raw, index) => {
    const where = `automation.rules[${index}]`;
    if (!isRecord(raw)) throw new Error(`${where} must be an object`);
    onlyKeys(raw, new Set(["id", "enabled", "when", "action", "agent"]), where);
    const id = nonemptyString(raw.id, `${where}.id`);
    if (ids.has(id)) throw new Error(`${where}.id must be unique`);
    ids.add(id);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`${where}.enabled must be boolean`);
    const when = normalizeCondition(raw.when, `${where}.when`, 0, { count: 0 });
    const action = validateAction(raw.action, `${where}.action`);
    const permissions = raw.agent ?? {};
    if (!isRecord(permissions)) throw new Error(`${where}.agent must be an object`);
    onlyKeys(permissions, new Set(['cancel', 'modify']), `${where}.agent`);
    for (const key of ['cancel', 'modify']) if (permissions[key] !== undefined && typeof permissions[key] !== 'boolean') throw new Error(`${where}.agent.${key} must be boolean`);
    return { id, enabled: raw.enabled ?? true, when, action, agent: { cancel: permissions.cancel ?? false, modify: permissions.modify ?? false } };
  });
}

export function validateAction(raw, where = 'action') {
  if (!isRecord(raw) || !ACTIONS.has(raw.type)) throw new Error(`${where}.type must be alert_phone, reply, or ignore`);
  onlyKeys(raw, new Set(raw.type === 'ignore' ? ['type'] : ['type', 'text']), where);
  const action = { type: raw.type };
  if (raw.type === 'reply' || raw.text !== undefined) {
    action.text = nonemptyString(raw.text, `${where}.text`);
    if (action.text.length > 8000) throw new Error(`${where}.text exceeds 8000 characters`);
  }
  return action;
}

export function validateAutomation(raw = {}) {
  if (!isRecord(raw)) throw new Error('automation must be an object');
  onlyKeys(raw, new Set(['rules', 'agent']), 'automation');
  const agent = raw.agent ?? {};
  if (!isRecord(agent)) throw new Error('automation.agent must be an object');
  onlyKeys(agent, new Set(['initiate', 'timeoutMs']), 'automation.agent');
  const initiate = agent.initiate ?? { when: 'never', actions: [] };
  if (!isRecord(initiate)) throw new Error('automation.agent.initiate must be an object');
  onlyKeys(initiate, new Set(['when', 'actions']), 'automation.agent.initiate');
  if (!['never', 'unmatched', 'always'].includes(initiate.when) || !Array.isArray(initiate.actions) || initiate.actions.some(t => !['alert_phone', 'reply'].includes(t)) || new Set(initiate.actions).size !== initiate.actions.length) throw new Error('initiate needs when (never/unmatched/always) and unique action types (alert_phone/reply)');
  const timeoutMs = agent.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('automation.agent.timeoutMs must be an integer from 1 to 30000');
  return { rules: validateDeterministicRules(raw.rules ?? []), agent: { initiate: { when: initiate.when, actions: [...initiate.actions] }, timeoutMs } };
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isMentioned(latest, names = []) {
  if (latest?.reaction) return false;
  const identities = Array.isArray(names) ? names.filter(name => typeof name === "string" && name.trim()).map(normalize) : [];
  const mentions = Array.isArray(latest?.mentions) ? latest.mentions : [];
  if (mentions.some(name => identities.includes(normalize(name).replace(/^@\s*/, "")))) return true;
  const text = normalize(latest?.text);
  return identities.some(name => new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "u").test(text));
}

function evaluateCondition(condition, context) {
  const { chat, latest, config } = context;
  if (Object.hasOwn(condition, "not")) {
    const child = evaluateCondition(condition.not, context);
    return { type: 'not', matched: !child.matched, conditions: [child] };
  }
  if (Object.hasOwn(condition, "all") || Object.hasOwn(condition, "any")) {
    const key = Object.hasOwn(condition, "all") ? "all" : "any";
    const children = condition[key].map(child => evaluateCondition(child, context));
    const matched = key === "all" ? children.every(child => child.matched) : children.some(child => child.matched);
    return { type: key, matched, conditions: children };
  }

  const mentionNames = Array.isArray(config?.alerts?.mentionNames) ? config.alerts.mentionNames : [];
  const ignoredAuthors = Array.isArray(config?.alerts?.ignoreAuthors) ? config.alerts.ignoreAuthors : [];
  const authorRaw = latest?.author ?? "";
  const author = normalize(authorRaw);
  const selfNames = mentionNames.map(normalize);
  const ignored = ignoredAuthors.map(normalize);
  const isSelf = !author || author === "you" || selfNames.includes(author);
  const isIgnored = ignored.includes(author);
  const eligible = !isSelf && !isIgnored;
  const isReaction = Boolean(latest?.reaction);
  if (condition.type === 'reaction') return { type: 'reaction', matched: isReaction && !isIgnored, input: latest?.reaction || null };

  if (condition.type === "direct_message") {
    const chatRaw = chat ?? "";
    const chatNormalized = normalize(chatRaw);
    const identityMatch = Boolean(chatNormalized && author && chatNormalized === author);
    return {
      type: "direct_message", matched: eligible && !isReaction && identityMatch,
      input: { chat: chatRaw, author: authorRaw },
      normalized: { chat: chatNormalized, author },
      eligibility: { selfAuthor: isSelf, ignoredAuthor: isIgnored, reaction: isReaction },
      comparisons: { chatEqualsAuthor: identityMatch },
    };
  }

  if (condition.type === "mention") {
    const mentions = Array.isArray(latest?.mentions) ? latest.mentions : [];
    const mentionValues = mentions.map(value => String(value ?? ""));
    const targetNames = mentionNames.filter(value => typeof value === "string" && value.trim()).map(value => normalize(value).replace(/^@\s*/, ""));
    const semanticMatch = mentionValues.some(value => targetNames.includes(normalize(value).replace(/^@\s*/, "")));
    const text = normalize(latest?.text);
    const textMatch = targetNames.some(name => new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "u").test(text));
    return {
      type: "mention", matched: eligible && !isReaction && (semanticMatch || textMatch),
      input: { author: authorRaw, text: latest?.text ?? "", mentions: mentionValues, mentionNames },
      normalized: { author, text, mentions: mentionValues.map(value => normalize(value).replace(/^@\s*/, "")), mentionNames: targetNames },
      eligibility: { selfAuthor: isSelf, ignoredAuthor: isIgnored, reaction: isReaction },
      comparisons: { semanticMention: semanticMatch, explicitAtName: textMatch },
    };
  }

  const inputValue = condition.field === "chat" ? chat ?? "" : latest?.[condition.field] ?? "";
  const actual = String(inputValue);
  const expected = normalize(condition.value);
  const actualNormalized = normalize(actual);
  let comparison;
  if (condition.match === "exact") comparison = actualNormalized === expected;
  else if (condition.match === "contains") comparison = actualNormalized.includes(expected);
  else {
    const numericTokens = actualNormalized.match(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?![\p{L}\p{N}_]|\.\d)/gu) || [];
    comparison = numericTokens.includes(expected);
  }
  return {
    type: "textual", field: condition.field, match: condition.match,
    matched: comparison,
    input: { actual, expected: condition.value },
    normalized: { actual: actualNormalized, expected },
    comparison: { matched: comparison, ...(condition.match === "contains_number" ? { numericTokens: actualNormalized.match(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?![\p{L}\p{N}_]|\.\d)/gu) || [] } : {}) },
  };
}

export function evaluateRules({ chat, latest, config } = {}) {
  const rules = validateDeterministicRules(config?.automation?.rules ?? []);
  const context = { chat, latest, config };
  return rules.filter(rule => rule.enabled).map(rule => {
    const evaluation = evaluateCondition(rule.when, context);
    return { rule, matched: evaluation.matched, evaluation };
  });
}
