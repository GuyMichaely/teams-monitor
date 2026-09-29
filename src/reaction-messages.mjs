// Snapshot deltas, not an event bus. Teams badges expose counts, not reactor identities.
export function reactionMessages(messages, entry, activationId, observedAt = new Date().toISOString()) {
  const previous = entry.reactionSnapshot?.activationId === activationId
    ? entry.reactionSnapshot.messages : {};
  const snapshots = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
  const output = [];
  for (const message of messages) {
    const id = message.id || (message.time && message.author ? `${message.time}|${message.author}` : null);
    if (!id || !Array.isArray(message.reactions)) continue;
    const current = Object.fromEntries(message.reactions.filter(r => r && typeof r.key === 'string' && Number.isInteger(r.count) && r.count > 0)
      .map(r => [r.key, { emoji: r.emoji || r.key, count: r.count - (r.self ? 1 : 0) }]));
    const before = snapshots[id]?.reactions;
    if (before && typeof before === 'object' && !Array.isArray(before)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
        const oldCount = before[key]?.count ?? 0;
        const newCount = current[key]?.count ?? 0;
        if (!Number.isInteger(oldCount) || oldCount < 0) continue;
        const delta = newCount - oldCount;
        if (!delta) continue;
        const emoji = current[key]?.emoji || before[key]?.emoji || key;
        const verb = delta > 0 ? 'added' : 'removed';
        const actor = Math.abs(delta) === 1 ? 'Someone' : `${Math.abs(delta)} people`;
        output.push({
          author: 'Unknown reactor', time: observedAt, mentions: [],
          text: `${actor} ${verb} ${emoji} ${delta > 0 ? 'to' : 'from'} ${message.author || 'an unknown author'}'s message: ${JSON.stringify(message.text || '')}`,
          reaction: { key, emoji, change: delta > 0 ? 'added' : 'removed', count: Math.abs(delta), actorKnown: false,
            originalMessageId: id, originalAuthor: message.author, originalTime: message.time, originalText: message.text,
            observedAt, timing: 'Observed between polls; actual reaction time is unavailable' },
        });
      }
    }
    // First observation is a baseline, including after each orchestrator activation.
    delete snapshots[id];
    snapshots[id] = { reactions: current };
  }
  entry.reactionSnapshot = { activationId, messages: Object.fromEntries(Object.entries(snapshots).slice(-100)) };
  return output;
}
