import type {
  PolicyContext, PolicyActions, WakeContext, InterventionContext,
  ActionResultContext, AnyPolicyContext, ReactionBadge, Reaction,
} from '../../automation/policy-api.d.ts';

export async function handle(ctx: PolicyContext, actions: PolicyActions) {
  if (ctx.isDM || ctx.mentionsMe) {
    const result = await actions.alert({ chat: ctx.chatName, text: ctx.message.text });
    if (!result.ok) return result.error.code;
    await actions.delay(result, { afterMs: 1000 });
  }
  const badges = await actions.readReactions(ctx.chatName, ctx.messageId);
  if (badges.ok) badges.reactions.forEach((badge: ReactionBadge) => badge.self && badge.key);
  const reaction: Reaction | null = ctx.reaction;
  if (reaction) reaction.change satisfies 'added' | 'removed';
  // @ts-expect-error No unused message type field.
  ctx.message.type;
  // @ts-expect-error No arbitrary message properties.
  ctx.message.surprise;
  // @ts-expect-error Legacy current-message alias removed.
  ctx.latest;
  // @ts-expect-error Action outcome belongs to the result hook.
  ctx.outcome;
  // @ts-expect-error Alert payload has an explicit schema.
  await actions.alert({ text: 'test', kind: 'message' });
  // @ts-expect-error Tool names are checked in the editor.
  await actions.llm('test', { tools: ['invented_tool'] });
}

export async function onWake(ctx: WakeContext, actions: PolicyActions) {
  return actions.llm(ctx.prompt, { ...ctx.ceiling, conversationId: ctx.conversationId ?? undefined });
}
export async function onIntervention(ctx: InterventionContext, actions: PolicyActions) {
  return actions.llm(ctx.prompt, { ...ctx.ceiling, conversationId: ctx.conversationId });
}
export function onActionResult(ctx: ActionResultContext) {
  if (ctx.outcome.action.kind === 'message') ctx.outcome.action.text satisfies string;
  // @ts-expect-error Action-result callbacks do not receive an incoming message.
  ctx.message;
}
export function discriminate(ctx: AnyPolicyContext) {
  if (ctx.trigger === 'action_result') return ctx.outcome.state;
  if (ctx.trigger === 'message') return ctx.message.text;
  return ctx.prompt;
}
