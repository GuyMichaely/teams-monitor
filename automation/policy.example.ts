import type { PolicyContext, PolicyActions } from './policy-api.d.ts';

export async function handle(ctx: PolicyContext, actions: PolicyActions) {
  ctx.log.setAttributes({ isDM: ctx.isDM, mentionsMe: ctx.mentionsMe });
  if (!ctx.isDM && !ctx.mentionsMe) return;
  return actions.alertMessage();
}
