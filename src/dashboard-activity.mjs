// Pure view model, also embedded in the dashboard and exercised without a browser.
export function buildActivityGroups(items) {
  const groups = new Map();
  const invalid = (index, at) => ({ id: 'invalid:' + index, at: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null, chat: 'Invalid log format', latest: null, events: [], error: true, invalid: true, icons: [] });
  for (const [index, item] of (Array.isArray(items) ? [...items].reverse() : [null]).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.kind === 'invalid_log') { groups.set('invalid:' + index, invalid(index, item?.at)); continue; }
    if (item.kind !== 'flow') {
      // Auxiliary audit records are not message traces. No conversion of obsolete formats.
      if (['decision', 'alert'].includes(item.kind) && !item.flowId) groups.set('invalid:' + index, invalid(index, item.at));
      continue;
    }
    if (typeof item.flowId !== 'string' || !item.flowId || typeof item.chat !== 'string' || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || (item.effect != null && typeof item.effect !== 'string') || !['message', 'policy', 'brain_input', 'brain_output', 'decision', 'effect', 'error'].includes(item.stage)) {
      groups.set('invalid:' + index, invalid(index, item.at)); continue;
    }
    if (!groups.has(item.flowId)) groups.set(item.flowId, { id: item.flowId, at: item.at, chat: item.chat, events: [], latest: null, icons: [] });
    const g = groups.get(item.flowId);
    if (g.chat !== item.chat) g.invalid = true;
    if (Date.parse(item.at) < Date.parse(g.at)) g.at = item.at;
    g.events.push(item);
    if (item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)) g.attributes = { ...item.attributes };
    if (item.stage === 'message') {
      if (item.latest && typeof item.latest.text === 'string' && (item.latest.author == null || typeof item.latest.author === 'string')) g.latest = item.latest;
      else g.invalid = true;
    }
    if (item.stage === 'decision') { g.action = item.action; g.reason = item.reason; }
    if (item.stage === 'error' || item.status === 'error' || (Array.isArray(item.results) && item.results.some(r => r?.error))) g.error = true;
    if (item.stage === 'effect') g.done = true;
  }
  for (const g of groups.values()) {
    if (!g.latest || !g.events.some(e => e.stage === 'message')) g.invalid = true;
    if (g.invalid) { g.error = true; continue; }
    const actions = new Set();
    for (const e of g.events.filter(e => e.stage === 'effect')) {
      // Icons represent recorded success, not a model's proposal or a failed attempt.
      if (e.status === 'ok' && ['teams_reply', 'hold_message'].includes(e.effect)) actions.add('reply');
      if (e.status === 'ok' && ['phone_alert', 'phone_alert_backstop'].includes(e.effect)) actions.add('phone');
      if (e.status === 'ok' && e.effect === 'scheduled_reply') actions.add('scheduled_reply');
      if (e.status === 'ok' && e.effect === 'scheduled_phone') actions.add('scheduled_phone');
      if (e.effect === 'brain_actions' && Array.isArray(e.results)) {
        for (const r of e.results) if (r?.name === 'alert_phone' && !r.error && r.result != null && r.result?.sent !== false) actions.add('phone');
      }
    }
    g.icons = [...actions].map(a => ({ reply: { symbol: '🗣️', label: 'Teams reply sent' }, phone: { symbol: '🚨', label: 'Phone alert accepted for delivery' },
      scheduled_reply: { symbol: '⏳🗣️', label: 'Teams reply scheduled' }, scheduled_phone: { symbol: '⏳🚨', label: 'Phone alert scheduled' } })[a]);
    g.outcomes = [...actions].map(a => a.includes('phone') ? 'alarm' : 'reply');
    if (!g.outcomes.length && g.done && !g.error) g.outcomes.push('ignore');
  }
  return [...groups.values()].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}
