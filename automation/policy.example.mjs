// Trusted local JavaScript, evaluated by Bun in a bounded subprocess.
// Action results are pending proposals, not proof of delivery. Await each call.
export async function handle(ctx, { alert, llm }) {
  if (ctx.notifyAll || ctx.isDM || ctx.mentionsMe) {
    await alert(); // No model review/cancellation authority for these alerts.
    return;
  }
  const result = await llm('Consider this message and decide whether to alert me or propose a useful reply.', {
    // Omit conversationId for fresh history. Opt in with e.g. `chat:${ctx.chatName}`.
    tools: ['list_conversations', 'read_conversation', 'search_conversations', 'list_notes', 'read_note', 'search_notes', 'write_note', 'send_message', 'alert'],
    readChats: [ctx.chatName], writeChats: [ctx.chatName], initiateActions: ['message', 'alert'],
  });
  // result.ok is false on provider/permission/timeout errors. A policy can handle
  // those itself; failed model runs leave its earlier proposals unchanged.
  return result;
}

export async function onWake(ctx, { llm }) {
  return llm(ctx.prompt, { ...ctx.ceiling, conversationId: ctx.conversationId });
}

export async function onActionResult(ctx, actions) {
  // Optional: use ctx.outcome to handle failed/blocked/uncertain effects.
}
