# TM agent system - implementation plan and handoff

Read this and AGENTS.md when resuming after compaction. This plan is approved for
incremental implementation. Later user decisions recorded here supersede older
AGENTS.md decisions about automation YAML and zero dependencies on this branch.

## Current state and next step

- October 1 follow-up: user approved NVIDIA provider support in agentic and the
  small provider-only update on main. Both use Nemotron 3 Super, retaining Gemini
  as an option. Main remains non-agentic with no new dependencies; no branch merge.
  Earlier stable-main-unchanged statements below describe the original cutover
  baseline, not this approved provider change. See AGENTIC.md for provider setup.

- Stable checkout: C:/Users/GuyMichaely/projects/teams-monitor, main at
  e0a691827a93bfc4742f96b4530137a350635e15. Keep the stable checkout and its desktop
  system intact while implementing.
- Development and installed agentic checkout:
  C:/Users/GuyMichaely/projects/teams-monitor-agentic (manually managed Git worktree).
  The former C:/Users/GuyMichaely/.codex/worktrees/agentic/teams-monitor is disposable
  chat-managed storage, not the development/install target. Never put the installed
  system, credentials or live state back under .codex/worktrees. See AGENTIC.md.
- Branch name is exactly agentic (user correction; no codex/ prefix).
- All six implementation increments are complete and locally verified (October 1).
  Launch/API/permissions/recovery instructions are in AGENTIC.md. Real trial files
  and shortcuts are now prepared; live switching and real recipient/phone checks
  remain separate operational steps. The initial setup did not switch startup;
  recovery later launched the real trial from the permanent checkout. No merge.
- User approved real trial setup with separate TM — Prod / TM — Agentic shortcuts,
  one-time local config/credential/context/registration copy and independent state.
  Quit the active tray before opening the other. No setup-time process switch.
  Fake preview/provisions removed by request; fixtures only in automated tests.
- Commit and push completed increments to agentic. Do not merge into main or move
  the normal desktop installation until the user chooses the new version.
- Each increment must leave a usable, testable result. Update this status as work
  proceeds so later agents can continue without reconstructing the chat.

## Agreed design and latest corrections

- October 2 design corrections (planned, not an implemented redesign): no first-
  class work items/tickets or open/resolved states in the UI/structured model output.
  The agent may organize work in its own notes. Conversation continuity should be
  delineated by explicit user-code invocations; standalone chat/direct prompts are
  not wanted except for intervening in an active thread. No automatic work-item
  conversation scheme. Agent execution should support general Bun JavaScript within
  a real OS isolation/resource boundary (filesystem/network/syscall restrictions,
  time/memory/CPU limits and priority); host subprocess/timeouts are not that sandbox.
  Permissions must govern access to host action functions, including delayed work.
  No sandbox/code-execution capability has been added by these design corrections.

- Use the JavaScript/TypeScript OpenAI Agents SDK for the model/tool loop. TM owns
  permissions, action execution, scheduling, storage, and its existing dashboard.
  SDK dependencies are an intentional exception to the old zero-dependency rule.
- Start with the currently configured Gemini model through a small SDK model
  adapter. The user chose whatever is most convenient now, not a specific new
  model. Model/provider selection remains configurable.
- Deterministic policy is real JavaScript run by Bun before optional agent work.
  Provide context variables and action functions through explicit parameters.
- Keep normalized chat/author name equality for isDM; the user accepts it.
- Give the model the evaluated policy source, input values, action state, and
  previous model/tool results. No mandatory trace() calls or local-variable
  instrumentation. Computations in source need not be repeated as explicit values.
- Let the agent choose its workflow using scoped general tools. Do not require a
  project database schema or prescribed memory organization. Give it an introduction,
  optional person/chat briefs, conversation access, and freeform persistent notes.
- Reads execute during the agent run; external actions and edits are staged until
  successful completion. A failed model run leaves deterministic proposals intact
  and returns a structured error that the policy can handle.
- Expected permission denials, provider failures, invalid calls, and timeouts are
  results available to code. They are not ordinary unhandled policy exceptions.
- A true uncaught policy exception discards that handler's incomplete plan and is
  recorded as a visible fault. Delivery outcomes arrive through onActionResult.
- IMPORTANT USER CORRECTION: "requesting my takeover" is descriptive language for
  a constellation of behavior, generally attention-getting and reduced self-
  motivated activity. It is NOT a primitive. Do not implement requestTakeover(),
  a special takeover tool, or a mandatory takeover state machine. Use ordinary
  alerts, notes/context, choices about future work, and configurable autonomy
  controls. The agent can explain that it is waiting for the user and reduce its
  activity without invoking a special built-in handoff mechanism. Its permission
  ceiling must still be enforced; it cannot rewrite authoritative policy.
- Support fixed delayed actions AND delayed agent runs identified by context/session
  ID. Agent spawning, recursive runs, and parallel agents are deferred for v1.
- Browser Teams and migration to another machine are deferred. Current desktop CDP
  remains the Teams connection for this implementation.
- Keep one live executor. Development uses isolated state/ports and mocks/replay
  until a deliberate live cutover; do not make real recipient sends part of tests.

## Increment 1 - SDK integration

- Add the Agents SDK and required dependencies with a lockfile in agentic only.
- Give development its own data directory via TEAMS_MONITOR_HOME and its own ports;
  never share live dedupe, schedules, control credentials, or runtime files.
- Verify Bun compatibility using a small agent calling a harmless mock tool,
  receiving its result, and finishing.
- Implement the configured Gemini provider using the SDK model interface. Start
  with ordinary text/function calls; streaming is unnecessary.
- Return structured timeout/provider results. Record activity locally and disable
  automatic external SDK trace export.
- Done: a local command completes a real model/tool round trip; errors are returned
  as results. Load credentials privately and never commit or print them.

## Increment 2 - intake and action execution

- Process all newly observed eligible messages in order, using IDs for dedupe and
  a content fingerprint when IDs are absent. Preserve activation cutoff, self-message
  exclusions, and synthetic reactions.
- Save observed conversation history locally for reading/search. Report available
  coverage; the current visible tail is not a complete historical Teams archive.
- Introduce one Teams operation queue shared by polling, agent tools, scheduled
  work, and GUI presence. Model waits must not occupy the queue or stop polling.
- Reuse the scheduled sender's exact recipient/header/draft checks for all outgoing
  messages. Preserve latest-wins presence behavior.
- Add durable action records for immediate and scheduled work. Record an attempt
  before execution. Interrupted/ambiguous sends are uncertain and never replayed
  automatically. Recheck current reply permission immediately before sends.
- Done: several messages between polls are handled in order, repeated polling
  does not duplicate actions, and switching chats cannot redirect a send.

## Increment 3 - JavaScript policy

- Use automation/policy.ts, editable in the dashboard. Other settings stay YAML.
- Export handle(ctx, actions); optionally export onWake and onActionResult.
- Context includes message/history, chat/author names, isDM, mentionsMe, reaction
  details, time, and trigger type.
- Functions include sendMessage, alert, setStatus, delay, cancel, and llm.
- Action functions create pending proposals and return handles. delay changes a
  proposal's durable execution time rather than storing a closure/setTimeout.
- Expected failures return {ok:false,error:{code,message}}; accepted proposals
  report pending rather than implying they have been sent.
- Execute policy in a bounded Bun subprocess. Uncaught exceptions or runtime
  timeouts discard that handler's unfinished plan and record a fault.
- Validate syntax/exports before atomic activation. Invalid saves retain the active
  version. Live refresh preserves unsaved editor contents.
- Add replay of a recorded message with external actions disabled.
- Convert existing automation rules once, preserving behavior; remove the old
  automation-rule execution path after conversion. Keep conversion confined to
  development configuration until cutover. No permanent legacy adapter.
- Done: code reproduces current DM/mention alerts and can handle a denied reply or
  failed model call itself.

## Increment 4 - agent tools and permissions

- llm(promptOrContextId, options) starts an SDK run and returns its result to policy.
- General tools: list/read/search conversations; propose messages/alerts/status;
  schedule/cancel actions; list/read/search/write freeform notes. No takeover primitive.
- Each run specifies available tools, readable/writable conversation scope, and
  pending action IDs/fields that may be cancelled/modified. Enforce the same limits
  inside tool implementations, not just in tool descriptions. Global reply policy
  always applies; the present empty whitelist still blocks outgoing messages.
- Reads execute during the run. Stage sends, alerts, status, schedule changes, and
  note edits. A successful run applies its staged changes to the policy plan.
  A failed run discards its changes and returns an error; deterministic proposals
  remain available for the policy to retain or handle.
- Execute the final plan after its handler succeeds; record actual outcomes per
  action. Commit does not imply that every external effect succeeds.
- Defaults: configurable 30-second deadline, 10 model turns, three outgoing Teams
  messages per run. Late/cancelled runs cannot execute calls. One active agent run
  initially; queue additional work while monitoring continues.
- Final model text is a result for policy, never an implicit Teams send.
- Done: agent reads context, proposes an answer, vetoes only explicitly permitted
  actions, and returns recoverable failures without acquiring extra authority.

## Increment 5 - continuity, notes, and UI

- Reuse Brain context for the user's introduction/instructions. Add optional
  editable person/chat briefs.
- Give the agent a private freeform text/Markdown notes directory and basic file/
  search tools. It chooses its organization. Authoritative instructions/policy are
  outside its writable notes. Notes do not change permission ceilings.
- Persist SDK history per session, supply bounded relevant context, summarize older
  history when needed, and retain original records for retrieval.
- Keep actual action outcomes and pending schedules outside freeform notes.
- Add a simple agent panel: current work, recent tool calls/results, contextual
  waiting/attention information, notes, a direct prompt input, and generic controls
  for reducing/pausing autonomous activity. Do not encode a special takeover workflow.
- Agent uses ordinary alert and its notes/context to get the user's attention and
  reduce self-motivated activity when appropriate.
- Done: useful context survives restart, notes are editable, and the user can see
  what ran and control autonomous activity.

## Increment 6 - delayed runs and rollout

- Support fixed actions (message, phone alert, status) at a specified time, and
  agent wakeups carrying prompt, context ID, time, and permission ceiling.
- Wakeups enter through onWake, apply current policy, and cannot exceed their saved
  ceiling. They can resume an existing context or create a new session; no spawning
  of concurrent/recursive agents in v1.
- Show/cancel both kinds in the scheduling UI.
- Fixed actions retain missed/uncertain behavior. Overdue agent wakeups run once
  after restart with their lateness in context so the agent can reassess.
- Validate with replay before the user selects the new checkout for ordinary
  desktop operation. Retain stable main as rollback; only one live executor.

## Checks throughout

All smoke tests must import scripts/smoke-env.mjs before application modules.
Use isolated state and mock CDP, including positive send cases.

- Deterministic behavior without a model.
- Model/provider failure, malformed/unauthorized calls, timeout, and late results.
- Failed runs retain deterministic proposals; code can handle error results.
- Permissions changing between proposal, delay, and execution.
- Ordered intake, dedupe, verified recipient/draft handling, manual presence wins.
- Restart recovery and no duplicate or uncertain-send retries.
- Durable notes/sessions, wakeup ceilings, and generic autonomy controls.
- Dashboard atomic editing, replay, and actual execution results.

Useful existing modules: src/orchestrator.mjs, src/rule-policy.mjs, src/brain.mjs,
src/scheduled-actions.mjs, src/scheduled-teams.mjs, src/teams-presence.mjs,
src/context.mjs, src/local-paths.mjs, and src/dashboard-page.mjs.
Existing general integration tests include scripts/smoke-gui.mjs,
scripts/smoke-schedules.mjs, and scripts/smoke-presence.mjs.

SDK references:
- https://developers.openai.com/api/docs/guides/agents/sdk
- https://developers.openai.com/api/docs/guides/agents/models
- https://developers.openai.com/api/docs/guides/agents/running-agents

## Progress

October 2 conversation refinement implemented: explicit local `conversationId`
continuation, fresh calls by default, same-handler staged history, serialized live
decisions/RPC, conflict guards, reset archives/generations, and permission-scoped
scheduled continuation. Dashboard input now intervenes in an existing conversation;
run cancellation is separate. No ticket states or implicit per-chat model histories.
October 3: native Windows LPAC/Job Object Bun execution added without virtualization.
Always-present model compute tool, permission-checked host bridge, nested atomic
staging, per-call/global/saved resource ceilings, dashboard settings and real native
boundary tests. See AGENTIC.md. Linux/macOS and standalone scheduled code remain
future increments; the trusted policy editor is not sandboxed.

- [x] Preserve stable main and create isolated agentic worktree.
- [x] Save approved plan with the user's corrections before compaction.
- [x] Increment 1: SDK integration.
- [x] Increment 2: ordered intake and action execution.
- [x] Increment 3: JavaScript policy.
- [x] Increment 4: agent tools and permissions.
- [x] Increment 5: continuity, notes, and UI.
- [x] Increment 6: delayed runs and isolated rollout preparation (not live cutover).

### Completed implementation / verification

- Real JS policy, recoverable results, frozen source versions, bounded child,
  nonce-authenticated child protocol, atomic editing, one-time YAML rule conversion
  and deterministic replay. No old rules runtime/API is retained.
- SDK general tools enforce current per-call/global/saved wake permissions;
  successful work stages and atomically commits effects, pending edits, notes and
  session history. Failure/timeout/late work cannot alter deterministic plans.
- Notes/briefs/introduction, bounded sessions with retained originals, action ledger,
  direct prompts, active/read-only/paused modes and practical dashboard controls.
- Fixed message/alert/status jobs plus context-bearing agent wakeups, saved ceilings
  enforced even for direct onWake policy calls, overdue wake reassessment and
  interrupted/missed/uncertain no-retry behavior. Single live executor and owner
  run nonce checks prevent stopped/restarted queued sends from acquiring authority.
- Passing isolated smokes: agent-sdk, agent-storage, agent-intake,
  policy-conversion, agent-policy, agent-continuity, gui, dashboard,
  presence, schedules, self-messages, reactions and rule-execution. Mock models/CDP
  and fictional recipients only; real SDK/Gemini round trip was verified separately
  during increment 1. Browser QA checked the dark mock dashboard.
- Stable main remains at 0efa442b9b31ef0e752a9587eb42db7612ff810e, unchanged.
- October 1: installed TM — Prod and TM — Agentic shortcuts and initialized the
  ignored live trial settings/credentials/context/FID with converted JS policy.
  The production tray was not stopped/rebuilt. Fake preview/demo code removed.
  Tool policy blocked deletion of retired .agentic-dev output; it remains ignored
  and unused, pending manual removal. Runtime no longer manufactures fixtures.

### Increment 1 completed

- Pinned @openai/agents 0.18.0 and Zod 4.6.5 with bun.lock; frozen install verified
  on Bun 1.4.0. Main/deployed runtime remains untouched.
- src/agent/runtime.mjs supplies the bounded SDK tool loop and structured failures.
  Default deadline is 30 seconds, max 10 model turns, serialized tools, no automatic
  provider retries. Non-cooperative model timeout/late-output exclusion is tested.
- src/agent/gemini-model.mjs translates text/function tools and preserves exact
  Gemini parts/signatures/IDs through SDK history. Uses existing brain settings;
  additional providers/streaming/multimodal/server-side sessions are not implemented.
- SDK tracing/export and sensitive SDK console logging are disabled. Bounded local
  metadata/sanitized fault logs live in data/agent/activity.jsonl under selected home.
  Detailed tool bodies/action outcomes are for later increments, not logged yet.
- Former fake preview/demo launchers have been removed at the user's request.
- Verified foundation: test:agent-sdk, smoke-gui, frozen install.
- Real Gemini probe verified: one read_probe invocation and two model requests,
  using the private existing .env directly (no copy/logging). First attempt got a
  transient 503; a later AUTO tool-choice response skipped the probe, so the probe
  now requires its first tool call and returns to AUTO after the tool result.
- No monitor/policy/dashboard replacement, staged external actions, memory tools,
  wakeups or live cutover yet. Start increment 2 without treating this foundation as
  completed agentic behavior.
