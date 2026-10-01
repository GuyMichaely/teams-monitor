# Agentic branch

This checkout is experimental. Stable `main` and its installed desktop system
remain unchanged. Do not start this branch against real Teams while stable is running.

## Live trial and rollback

Install the two named desktop shortcuts from this worktree:

```powershell
bun install --frozen-lockfile
bun run desktop:setup-switching C:/Users/GuyMichaely/projects/teams-monitor
```

Setup does not start/stop either stack or change production code/configuration.
It copies only local settings, .env, brain context, Firebase service account and
current phone registration into ignored trial files, never overwriting existing
trial files. No old logs, dedupe, pending jobs, runtime/control state or notes are
copied. Existing YAML automation is converted in the trial copy only.

Quit the active TM tray, then open **TM — Agentic** to try it. To roll back, quit
agentic's tray and open **TM — Prod**. The original TM shortcut is retained.
Both use the same dashboard URL/auth, Teams connection and existing tunnel;
configuration and state remain independent. Do not run both stacks together.
Agentic refuses startup if another GUI occupies the configured port.

This runs real Teams, the configured model and real phone delivery. Reply policy
still gates outgoing Teams messages. Agent Read only/Paused do not disable
deterministic actions. No fake-data preview or simulated application mode exists;
fixtures are confined to automated tests. Interrupted/gap messages are not replayed.

## Model provider

NVIDIA is selected in `brain` YAML: `provider: nvidia`,
`model: nvidia/nemotron-3-super-120b-a12b`, `apiKeyEnv: NVIDIA_API_KEY`.
The private key lives only in ignored `.env`. Gemini remains selectable using its
model and `GEMINI_API_KEY`. Both run through the Agents SDK with the same tools,
permissions, deadlines, staged effects and local-only diagnostics. NVIDIA uses
the shared dependency-free HTTPS transport and the SDK Chat Completions converter;
tool output validation remains local. Empty/truncated output and provider errors
cannot commit model effects. Provider-specific history metadata stays local while
portable text/tool history continues across the switch. No automatic provider retry.
Free API Catalog access has trial-use/confidential-input restrictions; see README.

## Policy

Other settings remain YAML. The dashboard edits the trusted local JavaScript file
`automation/policy.mjs` under the selected application home. Invalid syntax/exports
leave the active file unchanged. Each invocation uses a frozen source version in
a bounded Bun subprocess. This prevents a loop from wedging intake, **not** a
security sandbox for arbitrary code. Do not paste untrusted code into this editor.

Exports:

- `handle(ctx, actions)` for incoming messages.
- Optional `onWake(ctx, actions)` for scheduled/direct agent work. Without it,
  the runtime calls the model with the saved/current permission ceiling.
- Optional `onActionResult(ctx, actions)` with `ctx.outcome` after an effect.

`ctx` includes `message`, `history`, `chatName`, `authorName`, `isDM`, `mentionsMe`,
`reaction`, `now`, `trigger`, `contextId`, the user introduction, and the chat brief.
History contains observed visible tails, not a complete Teams archive. Reactions
are synthetic messages with an unknown reactor, never inferred actor identities.
Messages predating activation and outgoing messages outside self-chat/echo testing
are archived but not handled.

Await action calls. They return `{ok:true,id,state:'pending'}` or a structured
`{ok:false,error:{code,message}}`; an accepted proposal has not been sent yet.

```js
export async function handle(ctx, a) {
  if (ctx.isDM || ctx.mentionsMe) {
    await a.alert();
    return; // The model has no veto here.
  }
  if (ctx.message.text.includes('1234')) {
    const reply = await a.sendMessage(ctx.chatName, 'I will check that.');
    if (!reply.ok) return a.alert('Reply blocked: ' + reply.error.code);
    const reviewed = await a.llm('Review the proposed reply.', {
      tools: ['read_conversation', 'cancel_action', 'modify_action'],
      readChats: [ctx.chatName],
      cancelIds: [reply.id], modifyIds: { [reply.id]: ['text'] },
    });
    // On model failure, the original proposal is unchanged. Code can handle it.
    return reviewed;
  }
}
```

Functions: `sendMessage(chat,text)`, `alert(textOrPayload)`, `setStatus(presence)`,
`delay(handle, ISOTime | timestamp | {afterMs})`, `cancel(handleOrId)`,
`modify(handleOrId,{text})`, `llm(prompt,permissions)`, and
`wake(prompt,{contextId,dueAt,permissions})`. Delay stores a fixed action, not a
closure or timer. Cancel/modify can target pending stored actions as well as this
handler's proposals; an execution race rejects the whole commit.

Existing YAML automation is converted once into standalone JavaScript when first
needed. The old config is retained in ignored `config.yaml.automation.bak`; the
automation mapping is removed from active YAML. There is no old rules runtime/API.

## Agent permissions and continuity

An `llm` call explicitly lists tools, `readChats`, `writeChats`, `initiateActions`,
`cancelIds`, and `modifyIds` (only `text`). Omitted permissions deny that capability.
Every call intersects `agent.ceiling` in YAML and any saved wake ceiling. Reply
policy is an additional ceiling, checked again after navigation: an empty whitelist
still permits **zero** Teams replies. Tools cannot change authoritative configuration.

Available tools: list/read/search conversations; send message, alert, set status;
schedule/cancel/modify actions; and list/read/search/write notes. Reads happen during
the SDK run. Effects and note edits are staged; a provider error, timeout, invalid
output or policy fault cannot commit its incomplete plan. Final model text is never
an implicit Teams send. No special takeover primitive, recursive or parallel agents.

Defaults: 30-second review deadline, 10 model turns, three outgoing Teams proposals.
Polling/heartbeat continue while the one active policy/model run waits. Original
run records and SDK history stay local; older history is summarized when necessary.
External SDK trace export is disabled.

Freeform `.md`/`.txt` notes are transactional records in `data/agent/store.sqlite`,
mirrored under `data/agent/notes/`. Edit through tools/dashboard (direct edits to a
mirror are not imported). Briefs and the existing Brain context provide background.
Actual effects and pending jobs are separate from notes and are included as context.

Dashboard modes: **Active**, **Read only**, **Paused**. Paused prevents model runs;
read-only prevents model-originated effects/edits. Deterministic policy and manual
scheduled Teams actions remain independent. Pending model actions recheck mode and
permissions at execution. Replay has both model and external effects disabled.

## Schedules and recovery

The existing message/status form remains. Agent jobs (including fixed alerts and
wakeups) appear in the agent action list and can be cancelled while pending.
The wake form stores prompt, context ID, due time and the current ceiling. `onWake`
cannot expand that saved authority and sees `latenessMs` if a wake was overdue.
The same saved limits also apply to direct deterministic calls inside `onWake`,
not only its model calls. Resulting delayed actions retain those limits.

Fixed jobs due while stopped/more than five minutes late are missed. Interrupted
attempts are uncertain, never automatically retried. Overdue wakeups enqueue once;
an interrupted already-started handler is also uncertain. A live loopback executor
lease prevents duplicates. GUI-owned Teams operations serialize polling, sends and
presence; a model wait never holds that queue. Send checks require exact unique
recipient, verified header, no existing draft and unchanged text before clicking.
Old queued broker calls lose authority when their owning run stops/restarts.

## Checks / cutover

```powershell
bun run test:agent-sdk
bun run test:agent-storage
bun run test:agent-intake
bun run test:policy-conversion
bun run test:agent-policy
bun run test:agent-continuity
bun run test:desktop-switching
bun --no-env-file scripts/smoke-dashboard.mjs
bun --no-env-file scripts/smoke-presence.mjs
bun --no-env-file scripts/smoke-schedules.mjs
```

Tests use temporary homes, mock models/CDP and fictional recipients. They do not
prove real recipient delivery, phone delivery, or a production cutover. Cutover is
a separate user decision: stop the stable stack first, select this checkout and
its intended local config/credentials, replay representative messages, then start
one live executor. Keep `main` as rollback; no merge/deployment was performed.
