# TypeScript policy API

This document describes the trusted local JavaScript policy configured in
`automation/policy.ts`. The policy runs once for each eligible incoming message
and must export:

```ts
import type { PolicyContext, PolicyActions } from './policy-api.d.ts';

export async function handle(ctx: PolicyContext, actions: PolicyActions) {
  // decide what to do
}
```

The policy is trusted local code. It runs in a bounded Bun child to prevent a
loop or slow policy from wedging message intake, but it is not the security
sandbox used by `execute_bun`.

## `ctx`

The runtime supplies a plain context object. Values are snapshots for this
invocation; changing them does not change Teams or configuration. The complete
editor declarations are in [automation/policy-api.d.ts](automation/policy-api.d.ts).
Bun transpiles TypeScript; runtime policy-save validation checks syntax and
exports, while VS Code provides type checking and definition lookup.

`PolicyContext` describes the message `handle` hook. `WakeContext`,
`InterventionContext`, and `ActionResultContext` describe the other hooks and
extend `BasePolicyContext`. `AnyPolicyContext` is their discriminated union;
`PolicyTrigger` is `'message' | 'wake' | 'intervention' | 'action_result'`.

| Field | Meaning |
| --- | --- |
| `message` | The incoming message object; complete fields described below. |
| `messageId` | TM's recorded message ID, used for replay and `readReactions`. Distinct from `message.id`, the Teams DOM ID. |
| `history` | Bounded observed message history available for this invocation. |
| `chatName` | Display name of the chat or direct-message conversation. |
| `authorName` | Display name of the message author. |
| `isDM` | `true` when the normalized chat name and author name match. |
| `mentionsMe` | `true` when Teams mention data or configured explicit `@name` text matches the configured user names. |
| `reaction` | Reaction details for a synthetic reaction message, or `null`. |
| `now` | ISO timestamp for the invocation. |
| `trigger` | Always `'message'` in `PolicyContext`. Other hooks have their own literal trigger. |
| `contextId` | Trigger metadata identifying the source context. It is not automatically used as model history. |
| `userProfile` | The configured user introduction/context. |
| `brief` | Optional saved brief for this chat/person. |
| `mentionNames` | Configured names used to recognize the user and mentions. |

`latest`, the duplicate `chat` field, `ignoreAuthors` and `notifyAll` are no
longer supplied. Conditions such as author exclusions belong in your policy.
`outcome` belongs only to `ActionResultContext`. `ceiling`, `prompt` and
`conversationId` are supplied for wakes/interventions, not incoming messages.

## `ctx.message`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | optional `string \| null` | Teams DOM message ID. Synthetic reaction messages omit it. |
| `author` | `string` | Author display name; synthetic reactions use `Unknown reactor`. |
| `text` | `string` | Extracted body text, with reaction badge labels removed. Synthetic reactions contain generated descriptive text. |
| `time` | `string \| null` | Original message timestamp from Teams, or observation time for a synthetic reaction. Ordinary invalid/pre-activation timestamps are excluded from handling outside explicit echo tests. |
| `mentions` | `string[]` | Mention display names found in Teams mention nodes, with leading `@` removed. Synthetic reactions use an empty list. |
| `reactions` | optional `ReactionBadge[]` | Visible badge snapshot. Other authors' snapshots are omitted from automatic message/history context; explicitly inspect them with `readReactions`. |
| `reaction` | optional `Reaction` | A synthetic reaction change, described below. |

There is no message `type`, `chat`, or arbitrary extra-property index signature.
Use `ctx.chatName` for the chat and `message.reaction` to distinguish reactions.

### `ReactionBadge` and `Reaction`

`ReactionBadge` describes one badge on an original message:

```ts
{ emoji: '👍', count: 2, self: false }
```

- `emoji`: displayed emoji/name obtained from Teams.
- `count`: visible total count, including your reaction when `self` is true.
- `self`: whether your account contributes to that badge.

`Reaction` describes a change between snapshots. Automatic handling only
creates these for messages authored by you (recognized using `mentionNames`
or Teams' `You` label). Other people's reactions to your messages remain
eligible even when the original message predates activation.

| Field | Type | Meaning |
| --- | --- | --- |
| `key`, `emoji` | `string` | Reaction identifier and display text. |
| `change` | `'added' \| 'removed'` | Direction of the badge count change. |
| `count` | `number` | Absolute net change after excluding your own badge contribution. |
| `actorKnown` | `false` | Badge scraping cannot identify the reactor. |
| `originalMessageId` | `string` | Teams ID, or timestamp/author key if Teams omitted an ID. |
| `originalAuthor` | `string` | Author of the original message. |
| `originalTime` | `string \| null` | Original message timestamp. |
| `originalText` | `string` | Original message body. |
| `observedAt` | `string` | ISO time when the badge change was observed. |
| `timing` | fixed `string` | `Observed between polls; actual reaction time is unavailable`. |

For example, the app creates a message saying `Someone added 👍 to Guy's
message: "hello"`. This text is a synthesized description, not a real Teams
chat message or a claim that the reactor is known. First observation/restarts
establish baselines. Only visible tails and net changes are observed. Both
`ctx.isDM` and `ctx.mentionsMe` are false for synthetic reactions.

For ordinary incoming messages, the useful minimal pattern is:

```js
export async function handle(ctx, actions) {
  if (!ctx.isDM && !ctx.mentionsMe) return;
  return actions.alertMessage();
}
```

## `actions`

Action functions create staged proposals. Always `await` them. A successful
return means the proposal was accepted into this invocation's plan; it does not
mean the external effect has already completed.

### `actions.alert(value)`

Proposes a phone notification with exactly the supplied display content:

```js
await actions.alert({
  title: 'Build failed',
  body: 'Project X failed its checks.\nPlease investigate.',
});
```

`AlertPayload` requires `title: string` and `body: string`, and accepts no other
fields. Both must be nonempty. The limits are 256 UTF-8 bytes for the title and
3000 UTF-8 bytes for the body; JSON-encoded content must also fit 3500 bytes,
leaving room for FCM transport metadata (escaping control characters uses space). Content
is not flattened or silently shortened; line breaks are preserved. Invalid
content returns `INVALID_ACTION` without staging an action. Transport IDs and
delivery timestamps are owned by the runtime.

These notifications still obey the phone's notification/alarm preferences and
use the configured primary/fallback transports and duplicate suppression.
They do not override ringtone, DND, or alarm settings. An updated APK is required.

### `actions.alertMessage()`

Proposes an alert for the current incoming Teams message. Its title is
`author · chat`; the body is flattened to one line and shortened to 200
characters, matching the previous message-alert presentation. It returns the
same action handle as `alert`, so it can be delayed, cancelled or modified.
Use it in `handle`; a hook without a message returns `INVALID_ACTION`.
Unmodified message alerts retain the Teams-message wire format, so they still
work with the currently installed APK. Editing their title/body converts them
to general notifications and requires the updated APK.

### `actions.readReactions(chat, messageId)`

Explicitly inspect any recorded message's last observed badges, including
other people's messages. Use `ctx.messageId` or the row `id` returned by
`read_conversation`/`search_conversations`, not `message.id` (the Teams ID).

```ts
const result = await actions.readReactions(ctx.chatName, ctx.messageId);
if (result.ok) console.log(result.reactions, result.observedAt);
```

Success returns `{ ok: true, chat, messageId, reactions: ReactionBadge[],
observedAt }`. Every poll refreshes the saved snapshot, including
duplicate messages. An empty array means the last snapshot had no badges.
A missing/unobserved snapshot or wrong-chat ID returns `NOT_FOUND`; corrupt
snapshot data returns `INVALID_DATA`. This reads saved observations, with
their timestamp, rather than navigating Teams for a live refresh.

The model tool is `read_reactions({chat, messageId})`; grant `read_reactions`
and the relevant `readChats` scope in `llm` options. Saved wake permissions
also govern deterministic `readReactions` calls. The tool is available through
the sandbox's permitted `tools` bridge under the same permissions.

### `actions.sendMessage(chat, text)`

Proposes a Teams reply to `chat`. The global reply policy is checked again just
before sending. With the current empty whitelist, this will be rejected for all
recipients.

```js
const result = await actions.sendMessage(ctx.chatName, 'I will look into it.');
if (!result.ok) await actions.alert({ title: 'Reply blocked', body: result.error.code });
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

### `actions.modify(handleOrId, changes)`

Changes `{ text }` for a pending Teams message, or `{ title }`, `{ body }`, or
both for a pending notification. Modification cannot change the action type or
recipient. Agent `modifyIds` grants those exact fields independently: a `text`
grant does not grant notification edits. The model's `modify_action` tool takes
`{ id, field: 'text' | 'title' | 'body', value }`. The sandbox convenience function
changes one field per call; trusted policy can change title and body together.

The model's `alert` tool takes `{ title, body }`. To schedule a notification using
the model's `schedule` tool, use `kind: 'alert'`, `title`, `body`, and `dueAt`;
unrelated schema fields are `null`. For policy code:

```ts
const alert = await actions.alert({ title: 'Reminder', body: 'Review the build.' });
if (alert.ok) await actions.delay(alert, { afterMs: 60_000 });
```

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

The runtime automatically supplies the exact evaluated policy source/version,
context values and current proposals in every `llm` request. No file-reading tool
or manual source copy is needed. `timeoutMs` bounds this model call (also capped
by `agent.timeoutMs`); keep the enclosing `agent.policyTimeoutMs` longer so the
policy can handle a timeout and finish its fallback.

[automation/policy.alert-review.ts](automation/policy.alert-review.ts) is a
ready-to-use alert decision policy. It computes `isDM || mentionsMe`, then asks
the model to return exactly `ALERT` or `NO_ALERT` within five seconds. A valid
decision can override the heuristic either way; timeout, provider failure or
invalid output uses the heuristic. Each call starts fresh. All read/action
permissions are empty; the model's existing isolated computation tool cannot
call host tools. Only the policy creates the chosen current-message alert.
`scripts/smoke-alert-review-policy.mjs` validates it without sending notifications.

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

An uncaught policy exception or policy timeout discards that handler's incomplete
plan. A recoverable model error/timeout discards that model call's changes and
returns an error, allowing the policy to retain its deterministic proposals.
Previously committed/executed work is unchanged.

## Optional policy exports

```ts
import type {
  WakeContext, InterventionContext, ActionResultContext, PolicyActions,
} from './policy-api.d.ts';

export async function onWake(ctx: WakeContext, actions: PolicyActions) {
  return actions.llm(ctx.prompt, { ...ctx.ceiling, conversationId: ctx.conversationId ?? undefined });
}

export async function onIntervention(ctx: InterventionContext, actions: PolicyActions) {
  return actions.llm(ctx.prompt, {
    ...ctx.ceiling,
    conversationId: ctx.conversationId,
  });
}

export async function onActionResult(ctx: ActionResultContext, actions: PolicyActions) {
  // Inspect ctx.outcome after an effect and optionally respond.
}
```

All hook contexts have `now`, `userProfile`, `trigger` and optional `contextId`.
Wake context adds `prompt`, `ceiling`, optional conversation ID/generation,
`due` (epoch milliseconds), `latenessMs` and `actionId`. Intervention context
adds `prompt`, `ceiling`, conversation ID/generation and optional `chatName`.

Action-result context adds only `outcome`: `{ id, action, state, result }`.
`action` is a typed message/alert/status union; `state` is one of `completed`,
`failed`, `blocked`, `missed`, `uncertain`, or `superseded`. Wake enqueueing does
not invoke this hook. `result` intentionally remains `unknown` because Teams
and phone transports produce different execution evidence; inspect/narrow it
before accessing fields. This is a specific opaque value, not permission to
add arbitrary properties to the surrounding interface.

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
host tools. `actions` provides mediated versions of alert, alertMessage, message, status,
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
