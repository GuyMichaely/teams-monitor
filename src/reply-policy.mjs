export function replyPolicy(config = {}) {
  const value = config.replyPolicy;
  if (value == null) {
    return { mode: "whitelist", entries: cleanEntries(config.whitelist?.autoSend) };
  }
  if (!["whitelist", "blacklist"].includes(value.mode) || !Array.isArray(value.entries) ||
      !value.entries.every((entry) => typeof entry === "string" && entry.trim())) {
    return { mode: "whitelist", entries: [] };
  }
  return { mode: value.mode, entries: cleanEntries(value.entries) };
}

function cleanEntries(values) {
  return Array.isArray(values) ? [...new Set(values.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean))] : [];
}

export function validateReplyPolicy(value) {
  if (!value || !["whitelist", "blacklist"].includes(value.mode) || !Array.isArray(value.entries) ||
      value.entries.length > 500 || !value.entries.every((s) => typeof s === "string" && s.trim() && s.length <= 300)) {
    throw Object.assign(new Error("Choose whitelist or blacklist and supply up to 500 non-empty chat names."), { httpCode: 400 });
  }
  return { mode: value.mode, entries: cleanEntries(value.entries) };
}

export function isReplyAllowed(config, chat) {
  if (typeof chat !== "string" || !chat.trim()) return false;
  const policy = replyPolicy(config);
  const listed = policy.entries.some((entry) => entry.toLowerCase() === chat.trim().toLowerCase());
  return policy.mode === "blacklist" ? !listed : listed;
}
