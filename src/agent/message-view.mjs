// Teams' badge key stays in storage/diffing; policy and tool views expose badge values.
export const publicBadges = badges => badges.map(badge => ({ emoji: badge?.emoji, count: badge?.count, self: badge?.self }));
export const publicMessage = message => message && Array.isArray(message.reactions)
  ? { ...message, reactions: publicBadges(message.reactions) } : message;
