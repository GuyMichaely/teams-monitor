# AGENTS.md — project knowledge transfer

Read this before touching anything. It captures architecture, operational procedures, and user decisions that are not necessarily obvious from individual files.

## What this is

A personal Microsoft Teams monitoring/alerting system. It drives the new Teams desktop client (MSIX/WebView2) over the Chrome DevTools Protocol, triages incoming messages with an LLM, and alerts the user's Android phone. Single user, runs on a Windows laptop, not a product. Priorities: reliable alerting > cautious automation > elegance.

## Architecture map

```text
src/
  teams.mjs         Teams WebView2/CDP core on port 9222.
  teams-presence.mjs Profile-menu presence control; no keyboard/search commands. Reads back status before confirming success.
  monitor.mjs       Unread detection + chat reading.
  brain.mjs         Gemini decision layer.
  deterministic-rules.mjs Unified config validation and rule evaluation with condition evidence.
  rule-policy.mjs    Configured actions plus bounded, permission-checked agent cancellation/modification/initiation.
  orchestrator.mjs  Poll → read → dedupe → decide → act → log. Writes real tick heartbeat.
  actions.mjs       Action registry including alert_phone.
  alerts.mjs        Configurable primary FCM/WebSocket delivery, optional fallback, and recovery.
  alert-runtime.mjs Persisted transport/FID generation/failure/backoff state.
  worker-control.mjs Optional Cloudflare Worker control-plane client.
  tunnel-health.mjs PC-side public tunnel probe when Worker is disabled.
  phone-health.mjs  Direct high-priority FCM health-transition sender.
  gui-server*.mjs   Dashboard, API, WebSocket alert hub and diagnostics.
  dashboard-page.mjs Single dashboard UI: controls, settings, message traces, logs.
  poll-status.mjs   Actual poll progress in data/poll.json (separate from heartbeat).
  reply-policy.mjs  Teams reply whitelist/blacklist, default deny-all whitelist.
  state.mjs         Gitignored runtime state/activity under data/.
  context.mjs       Loads ignored live config/profile, bootstraps from examples.
android-app/        Kotlin companion: FID, FCM, WS fallback, WorkManager, health policy.
cloudflare-worker/  Optional SQLite Durable Object control/watchdog plane.
scripts/
  smoke-gui.mjs         Real Bun GUI/WebSocket smoke.
  smoke-alert-state.mjs Delivery/failover/backoff/FID-generation smoke.
  smoke-health.mjs      Public tunnel health-transition smoke.
```

## Phone delivery

`config.alerts.transport` is the preferred primary, not an exclusive mode. Both FCM and WebSocket remain available.

### FCM registration

- New registrations use Firebase Installation IDs (FIDs).
- Android opts into FID registration and handles `FirebaseMessagingService.onRegistered(fid)`.
- Firebase auto-init owns routine registration freshness; explicit `FirebaseMessaging.register()` is only a recovery action.
- Phone persists FID before network sync, sends it direct to PC, durably retries failed direct uploads with WorkManager, and mirrors it to the optional Worker.
- PC stores current registration in `data/fcm-registration.json`.
- `data/fcm-device-token.txt` exists only as deprecated-token migration compatibility. Do not build new logic around it.
- Each stored registration has a monotonic generation. Every FCM send result is associated with the generation it used; stale results from an older FID must not alter newer FID health.
- PC sends raw Firebase HTTP v1 using `message.fid` for FIDs.

### WebSocket

- Orchestrator POSTs alerts to local GUI `/api/alerts`; GUI broadcasts `/ws/alerts`.
- Remote phone reaches that socket through the existing Cloudflare Tunnel.
- If WebSocket is preferred, Android keeps the foreground `AlertService` running.
- If FCM is preferred, WebSocket stays cold normally and can run temporarily for fallback/recovery.
- Reconnect is exponential 1/2/4/... seconds capped at 60 seconds with 30-second OkHttp pings.
- No Android boot receiver by deliberate choice; after phone reboot, open the app once.

### Failover and recovery

- Every alert gets an `alertId`; Android dedupes recent IDs across FCM and WebSocket.
- In healthy/retrying state, preferred transport is attempted first. If that alert fails, the alternate may carry it immediately.
- Configurable consecutive failures enter persisted `fallback` state.
- In fallback, alternate is attempted first and preferred is then tested with the same `alertId`.
- **User decision: one successful attempt on the configured primary is enough to restore it immediately.** Do not add success-count or receipt-ACK hysteresis unless the user explicitly changes this policy.
- For FCM, recovery success must belong to the current registration generation; an old in-flight result is ignored.
- A periodic silent FCM recovery control send runs while FCM is preferred and degraded (`alerts.failover.recoveryCheckIntervalMs`, 30s example). A successful current-generation send returns to `primary_working` and clears temporary WebSocket.
- Definitive invalid FCM registration bypasses transient retry threshold and enters FID repair/fallback immediately.
- FCM 429/5xx failures persist Retry-After/backoff state. Alerts during backoff use alternate delivery without manufacturing more FCM failure counts.

FCM error rule: never equate arbitrary HTTP 404 with invalid registration. `UNREGISTERED` is definitive. `INVALID_ARGUMENT` is registration-specific only when the FCM-specific detail indicates it and the response is not an explicit `google.rpc.BadRequest` payload error.

## Optional Cloudflare Worker

`cloudflare-worker/` is optional and `controlWorker.enabled` defaults false. It is a small control/recovery/watchdog plane, not the normal Teams-alert message path.

When enabled:

- PC mirrors transport/control state and a heartbeat gated by freshness of `data/heartbeat.json`.
- phone mirrors current FID and WebSocket state even when direct PC sync succeeds.
- Worker Durable Object tracks PC/phone state and health incidents.
- Worker alarm detects missing orchestrator heartbeat independently of the home tunnel.
- Worker probes `controlWorker.publicHealthUrl` from outside the home network, distinguishing PC alive/tunnel dead from PC dead.
- Worker can issue high-priority FCM control and health messages.
- phone still performs roughly 15-minute WorkManager safety reconciliation: direct PC first, Worker fallback; direct success also mirrors Worker.

A live-but-wedged CLI process must not keep Worker heartbeat alive; only a fresh orchestrator tick counts.

If Worker is disabled, `src/tunnel-health.mjs` self-probes `publicHealthUrl` from the PC and sends tunnel transition messages over FCM when possible. This preserves tunnel diagnosis but is less independent than the outside Worker probe.

Worker secrets: `CONTROL_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. Validate Worker changes with a local Wrangler dry run; deployment is a separate operational step.

## Android health behavior

PC-heartbeat and public-tunnel incidents are separate state machines using the same user-selected policy:

- `notify` (default)
- `alarm_now`
- `alarm_after_delay`
- `ignore`

Recovery clears only the matching incident, cancels only its delayed work and stops only health-watchdog audio owned by that incident. It must not silence a Teams alert alarm or another still-active health incident.

Health state can arrive by Worker FCM push, Worker safety poll, or (with Worker disabled) direct PC FCM tunnel-transition push.

## Current operating decisions

- There is no separate alert-only mode. Teams replies (including hold messages) are controlled solely by replyPolicy; the live policy is an empty whitelist, so nobody may receive replies. Phone alerts and deterministic alarm/ignore rules remain independent of reply permission.
- Keep Gemini for now; a local-model replacement is deferred. Direct access to OpenCode's free Muse Spark endpoint returned a client-restriction 403; do not add an OpenCode harness workaround.
- Heuristics and deterministic rules share `automation.rules`: each rule has id, optional enabled, when, action, and optional agent.cancel/modify permissions (both default false). All enabled matching rules propose actions; identical resulting actions are attempted once. Conditions support direct_message, mention, field/match/value, and nested all/any. Direct matching uses normalized chat/author equality; mentions use semantic names or explicit @name text against alerts.mentionNames, not bare name references. Actions are alert_phone, reply (required text), or ignore (no-op for its own rule, not cancellation of other rules).
- `automation.agent.initiate` grants new-action authority with when never/unmatched/always and explicit actions alert_phone/reply; missing authority defaults to never/empty. The live/example config explicitly permits unmatched Gemini triage, while direct/@mention rules permit neither cancellation nor modification. Modification changes text only, never action type or destination. Review receives all evaluated definitions, tested values/results, proposals and permissions. Code validates the entire plan atomically; invalid/unauthorized output, provider error or timeout retains original configured actions (including permitted canned replies), adds nothing, aborts the request and ignores late output. timeoutMs defaults 5000 (1..30000). Valid cancellations are final. Teams sends always recheck current replyPolicy immediately before execution; review cannot override it.
- Reply permission applies only to outgoing Teams replies (including hold messages), never phone alerts. `replyPolicy` defaults to an empty whitelist; legacy `whitelist.autoSend` is read only when the new policy is absent. Blacklist mode permits all chats except listed exact names. Matching is case-insensitive.
- Dashboard copy should be practical and literal; dark mode is the default.
- User-facing application name is TM (desktop window/tray/process/shortcut, dashboard, Android app/service). Preserve the Android package, notification channel IDs, signing identity and stable APK download URL across display-name changes.
- The dashboard's Advanced alert rules section is always visible, not collapsible. One YAML editor edits the complete automation object through authenticated `/api/policy/automation/yaml`. Saves apply next poll; invalid config leaves the saved file unchanged. Live refresh preserves unsaved input. There is no legacy heuristic/override config adapter.
- Dashboard Teams availability uses the profile menu over CDP, with bounded target discovery and no search-box focus dependency. Presence reads do not open menus; changes never type into Teams. `bun scripts/smoke-presence.mjs` uses an isolated mock CDP server.
- Message activity uses an optional, editable date cutoff in `data/activity-view.json`. Hide-through-selected sets that same cutoff; moving it earlier or disabling it restores retained records. Audit JSONL and dedupe state are never deleted; `flowStartedAt` prevents late handling stages from reviving hidden messages. The dashboard accepts current flow traces only and labels malformed/incompatible entries as invalid log format.
- Teams presence selections apply immediately through a serialized latest-wins queue. Superseded requests must not overwrite the latest UI selection, including during Teams verification.
- Delivery-setting saves broadcast primary transport and WebSocket policy together to connected phones. Android reconciles policy on socket connection to recover missed updates; FCM without fallback must not retain an obsolete WebSocket service.
- Runtime is Bun 1.4+.
- Application settings use `config/config.yaml` and tracked `config/config.example.yaml`, parsed with built-in Bun.YAML. All config saves go through context.saveConfig (validated atomic replacement). Dashboard automation YAML is parsed server-side; API envelopes and state remain JSON. One-time `scripts/migrate-config-yaml.mjs` verifies exact values and retains ignored `.json.migrated.bak` originals. No runtime JSON-config fallback. Firebase/Android vendor JSON formats stay unchanged. YAML formatting/comments are normalized on save.
- Development and validation are local, with one explicit exception: the Android APK GitHub Action builds and publishes the signed APK to the `android-latest` release. Keep other hosted build/test/publishing workflows removed unless the user requests them.
- Normal Windows startup: TM desktop shortcut / `bun run desktop`; native tray app (`scripts/windows/TeamsMonitorTray.cs`) starts the supervised GUI, orchestrator and existing tunnel. Closing its window hides it; tray Quit requests local stops and closes the handle-owned Windows job to terminate remaining descendants. Duplicate shortcut launch reopens status. Rebuild/install via `bun run desktop:install` with tray quit first. All generated binaries/icons/logs are ignored under data/desktop. Manual launch only; no autostart. `scripts/start-stack.ps1` delegates to the desktop launch.
- `scripts/start-desktop.ps1` uses the existing Explorer desktop's automation object, not a new Shell.Application's ShellExecute or a newly launched explorer.exe. Live launch verified parent PID belonging to existing Explorer. Generic job membership is not proof of a Codex job. Tray startup logs include parent PID, and supervisor exits include exit code. Tray owns only its started supervisor/tree; an existing external GUI supervisor/monitor is refused, and quit checks live ownership before API stops. Initial launch recreates the scoped existing tunnel under GUI/tray ownership; subsequent Start system resumes stopped components. Tests: scripts/smoke-desktop.mjs (isolated state, real Windows job and WinForms checks).
- Terminal GUI-only operation: `bun run gui` runs its supervisor; status/intentional stop: `bun run gui:status` / `bun run gui:stop`. Debug unsupervised GUI: `bun run gui:direct`; direct orchestrator: `bun start`.
- Desktop Stop system shuts down the full owned stack (GUI supervisor/GUI, orchestrator, tunnel) and retains the tray app/window. Start system recreates the owned job and restarts the stack. Quit shares the same shutdown path and exits the tray app. A requested stop is displayed as Stopped, not a supervisor failure; Start/Stop serialize with refresh and each other.
- Dashboard Runtime controls has Keep screen on, persisted as desktop.keepAwake (boolean, defaults true), authenticated PUT /api/config/keep-awake. Desktop tray reads local policy every refresh (normally five seconds, independent of GUI liveness). Enabled desktop-owned running stack keeps Windows display/system awake via UI-thread SetThreadExecutionState (ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED). Hiding retains it; toggle Off/Stop/Quit/disposal/session end/observed supervisor exit clears it on the same thread. Start reacquires if enabled; failures remain visible/retryable and transitions are logged. No input simulation, persistent power/security changes, or lock/session-expiry bypass. Terminal-only launches do not enable it. Tests are part of smoke-desktop/smoke-gui.
- Dashboard Scheduled Teams actions supports one-time messages/availability changes, local browser date/time converted to UTC, pending cancellation and last 100 results. Authenticated /api/schedules uses ignored data/scheduled-actions.sqlite (built-in bun:sqlite WAL/FULL, transactional claims/idempotent request IDs, no npm dependency). The orchestrator alone executes between polls/waits, never concurrent with its chat handling. Restart marks due-before-activation jobs missed and claimed jobs uncertain; >5-minute late jobs are missed. No automatic retries of attempted/uncertain jobs. Messages require current replyPolicy twice (including after navigation), exact unique rail chat + header verification in one bounded CDP session, empty composer, and unchanged recipient/text before clicking Send. Schedules never restart Teams. Status jobs call GUI presence queue with expiry so manual latest-wins still applies. Terminal GUI-only/paused monitor cannot execute jobs. Smoke: scripts/smoke-schedules.mjs; real recipient sends are not part of validation.
- September 28 supervisor cutover: tool-launched GUI and supervisor both have Windows job membership. WMI independent process creation returned actual Windows result 2 (Access denied), with and without breakaway flags; no WMI launcher shipped, no OS permissions changed. Prefer user-opened terminal startup to avoid the tool launcher's lifetime. This does not prove previous exits were job kills.
- GUI supervision (`src/gui-supervisor.mjs`) uses authenticated local `/api/liveness` (PID/run ID, no Teams/tunnel dependency), three failed probes after startup grace, bounded backoff and five restarts per ten minutes. Normal child exits/startup failures do not restart. Intentional stop must go through supervisor control; force-killing its child is considered unexpected. Loopback control port is GUI port + 1, with a random token in ignored data/supervisor/control.json. Never expose it through the tunnel. Never adopt/kill by a stale PID file.
- Dashboard System health includes GUI supervisor status via authenticated `/api/supervisor/status`. It queries live loopback control and checks child PID/run identity and freshness, never trusts a persisted healthy status. Only sanitized fields reach the browser, never control credentials. Checks continue every five seconds even with log tailing paused. Validate with scripts/smoke-supervisor-status.mjs.
- Per-run bounded stdout/stderr and lifecycle/exit records live under data/supervisor; direct CLI lifecycle logs live under data/lifecycle. Fatal diagnostics omit arbitrary error messages/source excerpts and preserve call sites; failures still exit nonzero. No native crash dumps or OS persistent configuration enabled. Tests: scripts/smoke-supervisor.mjs. Separate process supervision does not guarantee survival of a Windows job-wide kill; prefer manually launching from an independently opened terminal. No autostart/service/Task Scheduler.
- `GUI_TOKEN` is the selected GUI/WS/control auth layer; Cloudflare Access was rejected.
- Task Scheduler/autostart was blocked/rejected. Do not add it back without a new decision.
- After server changes, restart long-running GUI/orchestrator processes.

## Hard-won gotchas

- Reactions are synthetic messages, not a separate event framework. `src/reaction-messages.mjs` compares bounded per-message badge snapshots per activation. Badges expose emoji/count/self state, not actor identities: use “Unknown reactor,” never the original author. Exclude badge text from body dedupe; `type: reaction` is supported, while direct_message/mention never match synthetic reactions. First observation/restarts baseline reactions without replay; one already-observed chat is revisited per tick after unread chats. Visible 15-message tails and net count changes only (no claim of complete reaction history).
- Ordinary messages before orchestrator activation or with invalid timestamps are skipped (echoLoop excepted). New observed reaction changes on old messages remain eligible after baseline.
- FCM attempt diagnostics include alertId, generation, send start, API acceptance/failure and duration; PC sends `fcmSendStartedAt`. Android records callback receipt before reconciliation, approximate cross-clock latency and receipt device state, with alertId across notification/alarm stages. Diagnostic persistence failures must not block delivery.
- Android log deletion is confirmed, strictly before a selected local date/time or age cutoff, independent of export filters. It serializes with append using AppLog's lock and atomically rewrites only diagnostics.log; malformed/undated/boundary records survive. No runtime state is deleted.
- GUI WebSocket connections are removed on peer TCP end, close/error, or missed matching pong. Server pings every 30s with a 10s deadline; cleanup records `ws_connection_removed` with a reason and clears timers. No Cloudflare changes or phone update are required. Connection-time transport bookkeeping reads current config rather than GUI startup config. Validate with `scripts/smoke-websocket-lifecycle.mjs`.
- GUI sends the current delivery policy on every WebSocket connection and settings save. If WebSocket is not wanted, it gives the phone 1s to stop, rechecks live policy, then closes any remaining socket (`delivery_policy_disabled`) even if it answers pings. Changing back to WebSocket cancels pending shutdown. Phone updates are still needed to fix obsolete reconnect/service behavior; server cleanup alone does not prove the installed app obeys policy.
- Message activity shows action emojis only for recorded actions; no-action entries have no emoji (the ignore outcome/filter remains).
- Android alert status is one wrapping primary-first line with explicit primary/backup roles, active backup, and per-transport colors. Off means not used for alert delivery (FCM controls remain enabled); idle WebSocket backup says standby, not disconnected. FCM ready reflects registration/sync, never a claimed live FCM socket. Tap for last control update/FCM receipt. Server health snapshots are presentation-only and cleared when a control update supersedes them; do not change delivery behavior to drive UI labels. DeliveryStatusTest covers wording, ordering, transitions and colors in the APK workflow.

1. Teams unread often does not clear; `processChat` dedupes latest message against prior `lastSeen`.
2. Self-chat is a test harness; `alerts.ignoreAuthors` is intentionally empty.
   Outgoing messages/edits in other chats are excluded before brain processing using `alerts.mentionNames` (and Teams' "You" author label). Incoming messages immediately before them remain eligible; self-chat and explicit echoLoop testing are preserved.
3. Heartbeat freshness exists because the orchestrator has died/wedged silently before.
4. Android notification channels are immutable; `alerts2` is deliberately silent and app alarm audio uses MediaPlayer.
5. `ACCESS_NOTIFICATION_POLICY` must remain for DND behavior.
6. No Android boot receiver by deliberate choice.
7. Cleartext Android traffic is disabled.
8. Runtime data/secrets must never be committed: `data/`, `.env`, live config/profile and Firebase credentials remain ignored.
9. Android signing key must remain stable so APK updates install over the existing app.
10. `alertId` dedupe is a correctness primitive for dual-transport attempts.
11. FID is the current registration architecture; do not add new dependencies on deprecated `onNewToken()`/`.token` APIs.
12. FCM backoff and registration-generation isolation are correctness requirements.
13. Worker is optional; core FCM/WS behavior must work with `controlWorker.enabled=false`.
14. Worker does not receive Teams message contents during normal operation.
15. Health incidents are independent; recovery of one must not clear another.
16. One current-generation primary success is the chosen recovery criterion.

## Secrets inventory

- `.env`: `GUI_TOKEN`, `GEMINI_API_KEY`.
- `config/fcm-service-account.json`: PC Firebase service account.
- `android-app/app/google-services.json`: Android Firebase config.
- `%USERPROFILE%\.android\debug.keystore`: local Android signing key; preserve it for compatible APK updates.
- Android Actions secrets: `ANDROID_DEBUG_KEYSTORE_BASE64` (the same stable signing key) and `FIREBASE_GOOGLE_SERVICES_JSON_BASE64` (Android Firebase config).
- optional Worker secrets listed above.
- `~/.cloudflared/`: local tunnel credentials.

## Conventions / status

- Main server intentionally has zero npm dependencies; use Bun/Node-compatible built-ins.
- ESM `.mjs`, terse WHY-comments; Android uses Views/appcompat + OkHttp + WorkManager.
- Android diagnostics exports support time/category/search filters (default last hour), with side-by-side Copy and Share file actions. Both bound output to newest matching entries; FileProvider exposes only the diagnostics cache with temporary read grants. Filter unit tests run in the Android APK workflow.
- Run the local Bun smoke scripts, Android build, or Worker dry run when touching their respective domains; commands are documented in the relevant README.
- All smoke scripts must import `scripts/smoke-env.mjs` before application modules. It supplies a temporary `TEAMS_MONITOR_HOME` for state/config/profile; tests must never clean or overwrite live `data/` files.
- FID + hybrid FCM/WS fallback/recovery, generation isolation, separate heartbeat/tunnel health and optional Worker are implemented.
- Worker live deployment and real-device FCM/failover tests are operational steps, not behavior proven by local smoke checks.
- TFS integration remains disabled/un-deployed.
