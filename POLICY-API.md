# JavaScript policy API

This document describes the trusted local JavaScript policy configured in
`automation/policy.mjs`. The policy runs once for each eligible incoming message
and must export:

```js
export async function handle(ctx, actions) {
  // decide what to do
}
```

The policy is trusted local code. It runs in a bounded Bun child to prevent a
loop or slow policy from wedging message intake, but it is not the security
sandbox used by `execute_bun`.

## `ctx`

The runtime supplies a plain context object. Values are snapshots for this
invocation; changing them does not change Teams or configuration.

| Field | Meaning |
| --- | --- |
| `message` | The incoming message object. Common fields include `id`, `text`, `author`, `time`, `chat`, `mentions`, and `type`. |
| `history` | Bounded observed message history available for this invocation. It is not a complete Teams archive. |
| `chatName` | Display name of the chat or direct-message conversation. |
| `authorName` | Display name of the message author. |
| `isDM` | `true` when the normalized chat name and author name match. |
| `mentionsMe` | `true` when Teams mention data or configured explicit `@name` text matches the configured user names. |
| `reaction` | Reaction details for a synthetic reaction message, or `null`. |
| `now` | ISO timestamp for the invocation. |
| `trigger` | Why the policy ran, such as an incoming message, wake, or intervention. |
| `contextId` | Trigger metadata identifying the source context. It is not automatically used as model history. |
| `userProfile` | The configured user introduction/context. |
| `brief` | Optional saved brief for this chat/person. |
| `ceiling` | The permissions available to this invocation. It is an upper bound, not an authorization to bypass the reply policy. |

For ordinary incoming messages, the useful minimal pattern is:

```js
export async function handle(ctx, actions) {
  if (!ctx.isDM && !ctx.mentionsMe) return;
  return actions.alert({
    chat: ctx.chatName,
    author: ctx.authorName,
    text: ctx.message?.text ?? '',
    time: ctx.message?.time,
  });
}
```

## `actions`

Action functions create staged proposals. Always `await` them. A successful
return means the proposal was accepted into this invocation's plan; it does not
mean the external effect has already completed.

### `actions.alert(value)`

Proposes a phone alert. `value` may be a string or a structured payload, for
example:

```js
await actions.alert('You were mentioned');
await actions.alert({ chat: ctx.chatName, text: ctx.message.text });
```

### `actions.sendMessage(chat, text)`

Proposes a Teams reply to `chat`. The global reply policy is checked again just
before sending. With the current empty whitelist, this will be rejected for all
recipients.

```js
const result = await actions.sendMessage(ctx.chatName, 'I will look into it.');
if (!result.ok) await actions.alert(`Reply blocked: ${result.error.code}`);
```

### `actions.setStatus(presence)`

Proposes a Teams presence change, subject to the invocation permissions and the
latest-wins presence queue.

### `actions.delay(action, when)`

Moves a staged action to a future execution time. It stores a durable action,
not a JavaScript closure or timer. `when` may be an ISO timestamp, epoch
milliseconds, or `{ afterMs: number }`.

### `actions.cancel(handleOrId)`

Proposes cancellation of a pending action that this invocation is allowed to
cancel.

### `actions.modify(handleOrId, { text })`

Proposes changing the text of a pending action. Modification cannot change the
action type or recipient.

### `actions.llm(prompt, permissions)`

Runs the configured model with explicitly requested tools and scopes. Every
permission is intersected with the global `agent.ceiling`; omitted permissions
are denied. Model effects are staged and only become part of the policy plan if
the model run succeeds.

```js
const review = await actions.llm('Review this message.', {
  tools: ['read_conversation'],
  readChats: [ctx.chatName],
  writeChats: [],
  initiateActions: [],
  cancelIds: [],
  modifyIds: {},
  conversationId: `chat:${ctx.chatName}`,
});
```

`conversationId` is optional. Omitting it starts fresh model history. Supplying
one continues that explicitly named local history; it does not create an
OpenAI-hosted conversation.

### `actions.wake(prompt, options)`

Schedules a future agent invocation. A wake can include `conversationId`,
`dueAt`, and an explicit permission mapping. It cannot exceed the current
ceiling. Scheduled wakes are durable actions and can be cancelled from the UI.

## Results and failures

Action results generally have this shape:

```js
{ ok: true, id: 'action-id', state: 'pending' }
```

Expected failures are returned as values:

```js
{ ok: false, error: { code: 'DENIED', message: '...' } }
```

Policies can inspect these results and choose another action. Common error codes
include `DENIED`, `INVALID_TOOL_CALL`, `NOT_FOUND`, `NOT_PENDING`, timeout and
provider failure codes.

An uncaught policy exception, timeout, invalid model output, or permission
change discards that handler's incomplete staged plan. Earlier committed work
is not undone. External actions that were already executed remain executed.

## Optional policy exports

```js
export async function onWake(ctx, actions) {
  return actions.llm(ctx.prompt, ctx.ceiling);
}

export async function onIntervention(ctx, actions) {
  return actions.llm(ctx.prompt, {
    ...ctx.ceiling,
    conversationId: ctx.conversationId,
  });
}

export async function onActionResult(ctx, actions) {
  // Inspect ctx.outcome after an effect and optionally respond.
}
```

These hooks are optional. There is no special takeover primitive; ordinary
alerts, notes, reduced permissions, and later decisions are the available
mechanisms for getting the user's attention.

## Sandboxed `execute_bun` code

Model code invoked through `execute_bun` is different from the trusted policy.
It receives:

```js
async function userCode(ctx, actions, tools, input) {
  // arbitrary async Bun JavaScript within the native sandbox
}
```

`input` is parsed from the caller's JSON input. `tools` contains only granted
host tools. `actions` provides mediated versions of alert, message, status,
delay, cancel, and modify. It has no direct host filesystem or network access.
On Windows it runs in a native LPAC/Job Object boundary with resource limits;
there is no unsandboxed fallback.

## Related configuration

- `agent.ceiling` limits model tools, chat scopes, action initiation,
  cancellation, and modification.
- `agent.sandbox` limits sandbox time, memory, CPU, process count, and output.
- `replyPolicy` independently controls outgoing Teams replies.
- Dashboard policy saves validate syntax before replacing the active policy.

The policy editor is intended for trusted local code. Do not paste untrusted
JavaScript into it; use `execute_bun` for model-generated code that needs the
native restrictions.
