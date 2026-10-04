import type { PolicyContext, PolicyActions } from './policy-api.d.ts';

export async function handle(ctx: PolicyContext, actions: PolicyActions) {
  if (!ctx.isDM && !ctx.mentionsMe) return;
  return actions.alert({
    chat: ctx.chatName,
    author: ctx.authorName,
    text: ctx.message?.text ?? '',
    time: ctx.message?.time,
  });
}
