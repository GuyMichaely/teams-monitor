// Filter whole flows by their original observation time, not later handling stages.
export function filterActivityAfter(records, through) {
  if (!through) return records;
  const cutoff = Date.parse(through);
  const starts = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object' || !r.flowId) continue;
    const start = Date.parse(r.flowStartedAt || r.at);
    starts.set(r.flowId, Math.min(starts.get(r.flowId) ?? Infinity, start));
  }
  const known = new Set(records.filter(r => r && (r.flowStartedAt || r.stage === 'message')).map(r => r.flowId));
  return records.filter(r => {
    if (!r || typeof r !== 'object') return true;
    if (r.kind === 'invalid_log' || !Number.isFinite(Date.parse(r.at))) return true;
    if (!r.flowId) return Date.parse(r.at) > cutoff;
    return known.has(r.flowId) && starts.get(r.flowId) > cutoff;
  });
}

// Date's permissive parsing rolls invalid calendar dates forward; reject those.
export function parseActivityDate(value, valid = true) {
  const parts = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!valid || !parts) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const expected = parts.slice(1, 7).map(n => Number(n || 0));
  const actual = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  if (actual.some((n, i) => n !== expected[i])) return null;
  return date.toISOString();
}
