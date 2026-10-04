# Agentic branch

This checkout is experimental. Stable `main` and its installed desktop system
remain unchanged. Do not start this branch against real Teams while stable is running.

## Live trial and rollback

The installed agentic system lives in the permanent, manually managed Git worktree
`C:/Users/GuyMichaely/projects/teams-monitor-agentic`. Production remains in
`C:/Users/GuyMichaely/projects/teams-monitor`. Do not run the installed system from
`~/.codex/worktrees`: archiving a Codex chat can remove its managed checkout,
including ignored configuration, credentials and runtime data.

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

The Windows tray icon opens its status window on a single left click. During
startup the Stop button becomes **Cancel startup**, which cancels the current
startup operation, releases keep-awake and tears down only its owned process tree,
leaving the app available to start again. **Quit TM** in the window or tray menu
cancels startup if necessary, stops the owned stack and exits the native app.
Closing the window with X still hides it without stopping the system.

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
`automation/policy.ts` under the selected application home. Invalid syntax/exports
leave the active file unchanged. Each invocation uses a frozen source version in
a bounded Bun subprocess. This prevents a loop from wedging intake, **not** a
security sandbox for arbitrary code. Do not paste untrusted code into this editor.

Exports:

- `handle(ctx, actions)` for incoming messages.
- Optional `onWake(ctx, actions)` for scheduled agent work. Without it,
  the runtime calls the model with the saved/current permission ceiling.
- Optional `onIntervention(ctx, actions)` for a user intervention in an existing
  named conversation. Without it, the runtime continues the selected history with
  the intervention prompt and that invocation's saved permissions.
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
`wake(prompt,{conversationId,dueAt,permissions})`. Delay stores a fixed action, not a
closure or timer. Cancel/modify can target pending stored actions as well as this
handler's proposals; an execution race rejects the whole commit.

Existing YAML automation is converted once into standalone JavaScript when first
needed. The old config is retained in ignored `config.yaml.automation.bak`; the
automation mapping is removed from active YAML. There is no old rules runtime/API.

## Agent permissions and continuity

The dashboard's **Agent permissions** YAML editor edits the complete `agent.ceiling`
mapping (not the whole config). It displays effective defaults, preserves unsaved
edits, validates before atomic save and retains unrelated settings. Keep all six
fields: `tools`, `readChats`, `writeChats`, `initiateActions`, `cancelIds`, `modifyIds`.
Empty lists/`modifyIds: {}` deny the capability; quoted `'*'` permits all chats or
action IDs in scope fields. Permissions are rechecked for each call and execution;
saving a ceiling does not expand an already queued task's saved authority or grant
tools omitted by policy. It does not sandbox trusted JavaScript. Authenticated
GET/PUT `/api/agent/permissions` uses `{source: <YAML>}`.

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

## Sandboxed Bun execution

The model always has `execute_bun({code,inputJson})`, even if `tools: []`.
`inputJson` is a JSON string or null. Code is an async JavaScript function body;
it receives `ctx` (the invocation context), `input` (parsed inputJson), `tools`
(the permitted host tools) and `actions`. Bun and built-in imports are available.

```js
// Code supplied to execute_bun, not the trusted policy editor:
const messages = await tools.read_conversation({chat: ctx.chatName, limit: 20});
if (!messages.ok) return messages;
return messages.messages.map(row => row.message.text).join('\n');
```

The convenience API is `actions.sendMessage(chat,text)`, `alert(text)`,
`setStatus(presence)`, `cancel(handle)`, `modify(handle,{text})` and
`delay(handle,{afterMs})` (also accepts an absolute timestamp). Delay requires
`schedule` permission and an action this model invocation proposed. Use
`tools.schedule(...)` for the existing fixed-message/status/alert/wake scheduling.
All bridge arguments, tools, chat scopes, action grants, UI mode and reply
whitelist are checked on the host. Raw guest protocol messages confer no authority.
The bridge is serialized. Await every call; unawaited calls make execution fail.

Only a successful guest result merges its nested staged plan. Code errors,
timeouts, cancellation, invalid output, resource limits or permission changes
discard that execution's changes, without discarding earlier successful model
tool calls. Failure is returned to the model so it can choose another approach.
A later model or whole-policy failure still discards the entire model/policy plan.

Native Windows x64 backend: LPAC with a unique per-run package identity, zero
capabilities, explicit stdin/stdout/stderr inheritance, no Win32k calls, and a
kill-on-close Job Object. Bun starts suspended until container identity, zero
capabilities and job assignment are verified. Jobs bound aggregate/process memory,
process count, total CPU capacity and priority. Wall time and combined output are
bounded; root completion terminates descendants. No WSL, VM, admin account,
loopback exemption, service or machine-wide ACL edits.

Direct networking, host private files and filesystem writes are denied. Each run
gets read-only copies of Bun/bootstrap plus a temporary read-only AppContainer
profile, removed on normal cleanup. Cleanup failures are recorded; a hard helper/OS
termination can leave a read-only bundle or profile, with no copied message contents
or credentials. Built-in imports work; installing packages, writing scratch files
and spawning subprocesses may be denied. Attempting a
network API can terminate Bun during Winsock startup rather than yield a catchable
exception; the host returns a sandbox failure and rolls back nested changes.
This is OS process isolation, not protection against Windows/Bun kernel/runtime
vulnerabilities. Some OS files exposed to LPAC remain readable. No claim of a
hermetic virtual machine or configurable host mounts/network grants.

Build once after checkout or native-helper changes: `bun run sandbox:build`.
The dashboard's **Bun sandbox** section shows whether the helper is built/current
and edits `agent.sandbox` resource limits. Limits default to 10s, 512MiB, 10% of
total CPU capacity, four processes and 64KiB combined guest output. SDK/policy
deadlines also apply and may be shorter. An `llm` call may provide a `sandbox`
mapping to lower limits; queued wakes/interventions preserve those limits.
Unsupported platforms or failed restrictions return `SANDBOX_UNAVAILABLE`; there
is never an unsandboxed fallback. Linux/macOS backends and scheduling arbitrary
code as a standalone job are not implemented by this increment.

Diagnostics include sandbox start, mediated tool results, final output/result and
whether effects were staged or discarded. Smoke: `bun run test:agent-sandbox`
(real Windows boundary plus fixture SDK, no provider calls or real sends).

Defaults: 30-second review deadline, 10 model turns, three outgoing Teams proposals.
Polling/heartbeat continue while the one active policy/model run waits. Original
run records and SDK history stay local; older history is summarized when necessary.
External SDK trace export is disabled.

### Explicit conversations

`conversationId` is a local history key, not an OpenAI-hosted conversation ID.
Omit it from `llm` options for fresh model history, even in a Teams chat that has
been handled before. Supply it to create or continue named history. Incoming
`ctx.contextId` is trigger metadata only; it is never an implicit history key.
Each invocation still supplies its own permissions; the ID grants no authority.

```js
const conversationId = `chat:${ctx.chatName.toLowerCase()}`;
const readOnly = { tools: ['read_conversation'], readChats: [ctx.chatName] };
const review = await actions.llm('Investigate this question without acting.', {
  ...readOnly, conversationId,
});
if (!review.ok) return actions.alert('Review failed: ' + review.error.code);
return actions.llm('Use the findings to decide what to do.', {
  ...readOnly, conversationId, tools: ['read_conversation', 'send_message', 'alert'],
  writeChats: [ctx.chatName], initiateActions: ['message', 'alert'],
});
```

Use a per-chat ID for recurring exchanges, a project ID for a policy deliberately
combining related chats, or a per-message ID for a later follow-up on one question.
These are code-chosen conventions, not managed tickets or open/resolved states.
Both calls above share staged history. The single decision worker serializes
handlers through commit; policy RPC serializes calls even with `Promise.all`.
Revision checks reject stale commits rather than overwriting newer history.
If read scope changes, prior history and summary are omitted; originals remain
in local run records. Long histories are summarized with no tools. Notes, chat
briefs, introduction, observed Teams messages and action records are shared;
model history/summary belong to the selected ID.

The dashboard selects existing model conversations. **Queue intervention** adds
the next turn, using the last/current invocation's permission grant intersected
with the live ceiling. It does not interrupt the current run. **Cancel current
run** aborts uncommitted policy/model work separately; executed actions remain.
**View history** includes retained reset archives. **Reset history** starts a new
generation, invalidates queued continuations of the old generation and prevents
an in-flight stale plan from committing. Actions already committed are unchanged.
IDs without a permission-bearing successful/current invocation cannot be used to
create a standalone chat from this form. Responses appear in tools/results.

Successful history and notes/actions commit together only after the whole policy
returns successfully. Provider failures and later policy exceptions do not update
history; `agent_result` records are explicitly marked staged-only. A custom
`onIntervention` must pass `ctx.conversationId` to its `llm` call and remains bounded
by `ctx.ceiling`. It may return a structured model failure to its caller just like
ordinary policy code. Neither intervention nor continuation is a permission bypass.

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
The wake form stores prompt, optional conversation ID, due time and a saved ceiling.
Blank ID means fresh history; an ID explicitly continues that history. Existing
named histories keep their prior grant on GUI-created wakes; new/fresh GUI wakes
use the current ceiling. Code-created wakes specify `permissions`. `onWake`
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
bun run test:agent-conversations
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
