function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const ACTIONS = new Set(["alarm", "ignore"]);
const FIELDS = new Set(["author", "chat", "text"]);
const MATCHES = new Set(["exact", "contains"]);

export function validateDeterministicRules(rules) {
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  return rules.map((raw, index) => {
    const action = String(raw?.action || "").toLowerCase();
    const field = String(raw?.field || "").toLowerCase();
    const match = String(raw?.match || "").toLowerCase();
    const value = String(raw?.value || "").trim();
    if (!ACTIONS.has(action)) throw new Error(`rules[${index}].action must be alarm or ignore`);
    if (!FIELDS.has(field)) throw new Error(`rules[${index}].field must be author, chat, or text`);
    if (!MATCHES.has(match)) throw new Error(`rules[${index}].match must be exact or contains`);
    if (!value) throw new Error(`rules[${index}].value must be non-empty`);
    return { action, field, match, value };
  });
}

export function matchDeterministicRule({ chat, latest }, rules = []) {
  for (const rule of rules) {
    if (!rule || !ACTIONS.has(rule.action) || !FIELDS.has(rule.field) || !MATCHES.has(rule.match)) continue;
    const actual = rule.field === "chat" ? chat : latest?.[rule.field];
    const haystack = normalize(actual);
    const needle = normalize(rule.value);
    if (!needle) continue;
    const matched = rule.match === "exact" ? haystack === needle : haystack.includes(needle);
    if (matched) return rule;
  }
  return null;
}

export function describeDeterministicRule(rule) {
  const subject = rule.field === "author" ? "author" : rule.field === "chat" ? "chat" : "message text";
  const operator = rule.match === "exact" ? "is" : "contains";
  return `${rule.action}: ${subject} ${operator} \"${rule.value}\"`;
}
