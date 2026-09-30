# teams-monitor

Personal Microsoft Teams monitoring/automation system. It drives the new Teams desktop client (WebView2) over the Chrome DevTools Protocol (CDP), triages unread messages, exposes a management GUI, and alerts an Android companion app through Firebase Cloud Messaging (FCM) and/or a WebSocket connection through the Cloudflare Tunnel.

## Requirements

- Windows with the new Teams desktop client (`ms-teams.exe`).
- Bun 1.4+.
- An existing Cloudflare Tunnel named `teams-gui` if remote GUI/WebSocket connectivity is wanted.

There are no server package dependencies.

Install Bun on Windows if needed:

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
bun --version
```

## Environment

Create an untracked `.env` in the repo root:

```dotenv
GEMINI_API_KEY=...
GUI_TOKEN=...
```

Bun loads it explicitly through the package scripts. Runtime state and logs stay under the gitignored `data/` directory.

The live configuration and brain profile are also machine-local and gitignored:

- `config/config.yaml` — runtime settings changed by the GUI, including polling interval and preferred alert transport.
- `context/user-profile.md` — freeform context/instructions supplied to the brain.

On first run, missing local files are automatically copied from `config/config.example.yaml` and `context/user-profile.example.md`. Edit the live files, not the tracked examples, for machine-specific settings that should survive `git pull`.

For an existing JSON installation, stop the GUI/monitor, run `bun scripts/migrate-config-yaml.mjs` once, then restart. It converts only `config/config.json` and `config/config.example.json`, verifies equal parsed values, and retains originals as ignored `.json.migrated.bak` files. It refuses to overwrite an existing YAML destination or backup. Firebase credential/Android configuration JSON, package manifests, and runtime JSON/JSONL keep their required formats. Normal startup reads YAML only.

## Normal startup

On Windows, use the **Teams Monitor** desktop shortcut. It opens a small status window and adds a tray icon. Closing the window hides it; double-clicking the tray icon (or desktop shortcut again) reopens it. Right-click the tray icon and choose **Quit Teams Monitor** to stop the monitor, tunnel, GUI and supervisor.

Install/rebuild the shortcut and native tray app after pulling changes (quit the current tray app before rebuilding):

```powershell
bun run desktop:install
bun run desktop
```

The app is compiled locally using Windows' .NET Framework compiler; no downloaded runtime, administrator rights, execution-policy changes or boot startup are needed. The installer creates `Teams Monitor.lnk` in the actual desktop folder, including a redirected OneDrive desktop. Generated executable/icon and local logs stay ignored under `data/desktop/`. Moving the repository requires reinstalling the shortcut.

The desktop launch starts the GUI supervisor, recreates the project's existing `teams-gui` tunnel under its ownership, and starts the orchestrator. Teams must already be available with CDP enabled. Start/stop controls in the dashboard still work; the tray's **Start system** starts components that were stopped there. An already-running external GUI supervisor or monitor is refused: stop it from its terminal/dashboard first (`bun run gui:stop` for the GUI supervisor). A duplicate desktop launch only reopens the current window.

The native tray app owns a Windows job containing the supervisor and its descendants. Children are assigned before they execute, and dashboard-started monitor/tunnel processes inherit that ownership. Tray Quit first requests the authenticated local stop controls, then closes the owned job to clean up remaining processes even if the GUI is unavailable. It never kills using an old PID file. Tray crashes, Windows sign-out/shutdown and power loss can still stop the system; reopening the desktop shortcut starts it again. This is a manual launcher, with no service, Task Scheduler or login/reboot startup.

`scripts/start-desktop.ps1` asks the **existing desktop Explorer** to launch the native app. A newly created `Shell.Application` or `explorer.exe` may inherit the calling tool's context, so those are not the launch path. The live launch was checked with the existing Explorer PID as its parent. Generic Windows job membership alone does not identify a Codex-owned job. Tray lifecycle/observed supervisor exits are logged in `data/desktop/tray.log` (256 KiB plus one backup); GUI per-run diagnostics remain in `data/supervisor/`.

Validate with `bun scripts/smoke-desktop.mjs` after building the app. It uses isolated state and verifies close-to-tray, explicit quit, suspended job assignment, detached descendant ownership/cleanup, duplicate instance locking, local authentication and ownership checks. GUI supervisor verification is described below.

For terminal development or GUI-only operation:

From the repo root:

```powershell
bun run gui
```

This starts a **GUI-only supervisor** and the management GUI on the port configured in local `config/config.yaml` (8090 in the example). It does not start the orchestrator or tunnel. From the dashboard you can start/stop those separately.

```powershell
bun run gui:status
bun run gui:stop
# After stopping, start again with bun run gui.
```

For a manual production launch, run `bun run gui` in a separately opened Windows Terminal/PowerShell window and leave it open. Ctrl+C or `gui:stop` stops supervision and its GUI child without restarting either. `bun run gui:direct` runs without supervision for debugging. Do not stop the managed child with Task Manager as an intentional stop: that is an unexpected termination and will be restarted.

Operational check, September 28: the tool-launched supervisor and GUI both tested positive for Windows job membership. A WMI independent-launch experiment returned Windows result 2 (Access denied), including without breakaway flags, so no WMI launcher is shipped and no OS permissions were changed. This is not evidence that a job kill caused the earlier incidents. Launch from your own terminal to avoid relying on the tool's job lifetime. See [Windows job documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The supervisor is a separate process, not an installed service. A hidden window or detached launch does **not** prove independence from the launcher's Windows job object. Closing a controlling terminal, a job-wide kill, supervisor failure, Windows shutdown or power loss can still stop both. There is no boot startup/Task Scheduler integration.

### GUI exit diagnostics and recovery

- Authenticated `/api/liveness` verifies the child PID and unique run ID without Teams/CDP, disk reads, Firebase or the public tunnel. Checks run every 5 seconds with a 2-second timeout. After a 15-second startup grace, three consecutive failures are recorded as **unresponsive**, not a proven crash, then the owned child is terminated and replaced.
- Unexpected exits after successful startup restart with 2/4/8/... second backoff (30-second cap). At most five restarts in ten minutes; reaching the limit leaves supervision blocked for inspection. A healthy run lasting a minute resets backoff, not the rolling restart budget. Normal exit (0), handled SIGINT/SIGTERM (130/143), initial application/spawn failure and an occupied GUI port do not restart. Use `gui:status`, inspect logs, then `gui:stop` and `gui` after resolving the problem.
- A loopback-only control listener on **GUI port + 1** prevents duplicate supervisors and authenticates status/stop with a random local token. Do not tunnel that port. Stale PID files are never used to kill or adopt another process; an occupied GUI port blocks startup.
- `data/supervisor/status.json` contains current state, run directory, PID and latest successful health timestamp/latency. `data/supervisor/session-*/supervisor.jsonl` records health transitions, requested kills, exit status/signal, uptime, last successful health and restart decisions. Numeric exit codes also get an unsigned Windows hex representation when the runtime supplies a number; a signal-only report is not fabricated into a native crash code.
- Each session has `run-*/stdout.log`, `stderr.log` and `run-*.jsonl` lifecycle evidence. Lifecycle logs record version/revision, runtime, run ID, PID/parent PID, fatal error type/code/call sites and normal exits. Fatal records are synchronous and flushed; exceptions/rejections terminate with failure, not continued execution. Arbitrary error messages/source excerpts are omitted from structured lifecycle records to avoid including credentials or message bodies. Unsupervised CLI lifecycle logs are in `data/lifecycle/`.
- New logs rotate at 256 KiB with two backups; retain five supervisor sessions and ten child runs per session. Standalone lifecycle files are also bounded. Rotation only affects these new diagnostic locations; existing activity/audit logs are untouched. stdout/stderr may contain sensitive application output: all evidence stays ignored/local, and nothing is uploaded automatically. Native Windows crash dumps are **not enabled**.

If both processes disappear, the last persisted health timestamp helps bound the incident, but there may be no final exit record. External forced kills and native failures cannot always be distinguished without OS evidence. Revision records identify the base commit; uncommitted working-tree changes are not captured in that revision.

Validate with `bun scripts/smoke-supervisor.mjs` (isolated state and disposable child processes), plus `bun scripts/smoke-gui.mjs` and `bun scripts/smoke-websocket-lifecycle.mjs`.

To run the monitor directly without the GUI:

```powershell
bun start
```

The all-in-one Windows launcher also uses the desktop tray app:

```powershell
.\scripts\start-stack.ps1
```

It installs the desktop launcher if missing, then asks the existing Explorer desktop to start it.

## CLI

```powershell
bun src/cli.mjs chats
bun src/cli.mjs unread
bun src/cli.mjs readchat "Andrew Coe"
bun src/cli.mjs read 10
bun src/cli.mjs send "hello"
bun src/cli.mjs watch 3000
bun src/cli.mjs run
bun src/cli.mjs stop
bun src/cli.mjs catchup
```

Equivalent package scripts are available for the common operations:

```powershell
bun start
bun run gui
bun run read -- 10
bun run send -- "hello"
bun run watch -- 3000
```

## Teams CDP setup

The monitor normally handles this automatically: if Teams is not running with a CDP port, it restarts Teams with the WebView2 remote-debugging argument scoped to that process.

Manual launch:

```powershell
.\scripts\launch-teams.ps1
```

Verify:

```powershell
Invoke-RestMethod http://localhost:9222/json/version
```

A persistent alternative is:

```powershell
setx WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS "--remote-debugging-port=9222"
```

The per-launch method is preferable because a persistent WebView2 debugging variable affects other WebView2 apps too.

## Architecture

```text
src/teams.mjs                  CDP/WebSocket core for Teams
src/monitor.mjs                unread enumeration + chat reading
src/brain.mjs                  decision layer
src/orchestrator.mjs           poll → read → decide → act → log loop
src/actions.mjs                action registry, including alert_phone
src/alerts.mjs                 primary/fallback phone-alert delivery
src/alert-runtime.mjs          persisted delivery/FID/failure/backoff state
src/worker-control.mjs         optional Cloudflare Worker control-plane client
src/tunnel-health.mjs          public tunnel self-check when Worker is disabled
src/gui-server*.mjs            dashboard, API, WebSocket alert hub, diagnostics
src/state.mjs                  runtime state/activity under data/
config/config.example.yaml     tracked configuration template
config/config.yaml             gitignored live configuration
context/user-profile.example.md tracked brain-profile template
context/user-profile.md        gitignored live brain context
android-app/                   Android companion app
cloudflare-worker/             optional independent control/recovery Worker
tfs-agent/                     separate TFS worker integration
```

### Phone alert delivery

`alerts.transport` is the **preferred** transport, not an exclusive mode. The other transport remains available as a fallback:

- **FCM** sends directly from the orchestrator to Google and does not require the GUI or Cloudflare Tunnel for normal delivery once the phone's Firebase Installation ID (FID) has been synchronized.
- **WebSocket** sends through the local GUI alert hub and, for a remote phone, the Cloudflare Tunnel.
- Every alert has an `alertId`; the Android app deduplicates IDs so fallback/recovery attempts cannot ring twice.
- A failed preferred attempt can use the alternate transport for that individual alert. Configurable consecutive preferred failures move the persisted delivery state into fallback mode.
- One successful attempt on the configured primary returns it to `primary_working`. For FCM, the result is accepted only if it belongs to the current registration generation; this prevents a delayed result from an older FID from recovering or degrading a newer one.
- FCM retryable 429/5xx failures respect `Retry-After`/backoff state instead of repeatedly hitting FCM.
- An invalid FCM registration is treated as a recovery event immediately rather than consuming the normal transient-failure budget.

When FCM is primary, WebSocket can therefore remain cold during normal operation and run temporarily during recovery. A periodic silent FCM recovery check is controlled by `alerts.failover.recoveryCheckIntervalMs`; one successful current-generation recovery send restores FCM and releases temporary WS.

FCM registration state lives in gitignored `data/fcm-registration.json`. Each registration has a generation number so delayed results from an older FID cannot mutate health for a newer one. The deprecated `data/fcm-device-token.txt` is retained only as a migration compatibility path.

### Optional control Worker and health monitoring

`cloudflare-worker/` contains an optional Cloudflare Worker backed by a SQLite Durable Object. It is **disabled by default** and is not part of normal Teams-message delivery. Its purpose is an independent control/recovery plane:

- mirror PC and phone control state;
- mirror the phone's current FID;
- receive an orchestrator heartbeat;
- detect heartbeat loss independently of the home tunnel;
- independently probe `controlWorker.publicHealthUrl` so “PC alive” and “public tunnel down” are distinct incidents;
- issue high-priority FCM recovery/health control messages when useful.

The Android app performs a roughly 15-minute WorkManager safety synchronization. It tries the direct PC endpoint first and uses the Worker when configured and necessary; direct success also mirrors state to the Worker so its shadow copy stays current.

When the Worker is disabled, the PC still self-probes `controlWorker.publicHealthUrl` on the health cadence and sends tunnel failure/recovery transitions over FCM when possible. The Worker version is more independent because it can observe a tunnel failure from outside the home machine.

See `cloudflare-worker/README.md` for deployment/secrets. `controlWorker.enabled` remains `false` until a Worker is actually deployed and its URL is configured.

## GUI diagnostics

The dark dashboard includes process controls, phone delivery selection with optional fallback, system health, reply permissions, and editable brain context. Firebase configuration details are collapsed under phone delivery.

Enable **Hide messages at or before** and choose a date/time to filter retained activity. **Hide through selected message** updates that same date. Move the date earlier or uncheck the filter to see older retained messages again. The cutoff persists across reloads without deleting diagnostic files or resetting deduplication. Outgoing messages and edits in other chats are filtered before the brain runs; self-chat and explicit echo-loop testing remain supported.

Teams availability selections apply immediately, even with the monitor stopped. The label shows **Setting status…** while pending; changing your selection supersedes earlier requests, including during verification. It uses Teams' profile menu over CDP, never types slash commands, and confirms the status by reading it back. Teams must already be reachable on port 9222; this control does not restart Teams. Multiple profile windows are rejected rather than choosing an account arbitrarily. The polling interval under Teams orchestrator controls the delay between Teams message polls, not Cloudflare tunnel checks.

**Message activity** shows recent messages and a selectable handling trace: message, reply permissions, brain input/output, decision, and action results. Messages and actual poll progress refresh every two seconds; health and system logs refresh every ten seconds. Poll progress records unread chats, handled messages, duplicates, errors, and the current stage in `data/poll.json`. Pausing updates affects this browser view only. Unsaved settings are preserved during refreshes.

**Teams reply permissions** uses `replyPolicy: { mode: "whitelist", entries: [] }` by default. An empty whitelist permits replies to nobody. Blacklist mode permits replies to all chats except the listed names; an empty blacklist permits all chats. Names are matched exactly, ignoring case. Existing `whitelist.autoSend` entries remain supported when `replyPolicy` is absent. The policy covers both replies and hold messages; phone alerts are unaffected. There is no separate alert-only mode: use the empty whitelist to prevent all replies.

**Automation rules and agent permissions** share one config in the always-visible **Advanced alert rules** YAML editor. It edits the `automation` mapping directly through authenticated `/api/policy/automation/yaml`; saves apply next poll, preserve unrelated settings, and reject invalid config without changing the saved file. HTTP envelopes and runtime state/logs remain JSON. Saves normalize YAML formatting and do not retain comments. Quote numeric-looking string values, such as `"1234"`. Example for the editor (the file nests this under `automation:`):

```yaml
rules:
  - id: mention-alert
    when: { type: mention }
    action: { type: alert_phone }
    agent: { cancel: false, modify: false }
  - id: number-reply-example
    enabled: false
    when: { field: text, match: contains_number, value: "1234" }
    action: { type: reply, text: "I will check that reference." }
    agent: { cancel: true, modify: true }
agent:
  initiate:
    when: unmatched
    actions: [alert_phone, reply]
  timeoutMs: 5000
```

Conditions support `type: "direct_message"` or `"mention"`, or `field: "text" | "author" | "chat"` with `match: "exact" | "contains"` and a string `value`. Text additionally supports `contains_number` for standalone unsigned integer/decimal tokens (not digits embedded in another number/word). Combine conditions with `all: [...]` or `any: [...]`. Matching is case-insensitive. Direct-message detection compares normalized chat and author names; renamed 1:1 chats may not match. Mentions use `alerts.mentionNames` against semantic Teams mention names or explicit `@name` text, not plain name references. Self/ignored authors do not trigger direct/mention conditions.

All matching enabled rules propose actions; this is not first-match-wins. Actions are `alert_phone` (optional summary `text`), `reply` (required `text`), or `ignore` (no action for that rule, not cancellation of other rules). Identical resulting actions are attempted once per message. The disabled number rule above is documentation only; choose your own number/reply before enabling it.

Per-rule `agent.cancel` and `agent.modify` default false. Modification permits changing text only, never action type or destination. Global `agent.initiate` controls independent model actions: `when` is `never`, `unmatched` (no enabled rule matched), or `always`; `actions` explicitly lists allowed action types. Missing initiation config defaults to `never` and no types. The live/example config explicitly allows phone alerts and whitelist-permitted replies on unmatched messages, retaining Gemini triage there. Live direct-message and mention rules permit neither cancellation nor modification, so those matches bypass the LLM unless another matching rule needs review.

The model sees every evaluated rule, tested values, condition results, proposed actions and permissions. One bounded request proposes changes/additions, which code validates before applying any. Protected/unknown targets, unauthorized additions, invalid responses, errors or timeout retain **all original rule actions**, including configured replies if permitted; no model additions run. `timeoutMs` is an integer from 1 to 30000; requests are aborted at the deadline and late outputs cannot change the result. Valid cancellations are final. Reply policy is checked again immediately before sending; the agent cannot bypass it. Traces include rule evidence, model input/output, retained/cancelled/modified/initiated actions, and execution results.

Reactions use ordinary synthetic messages in the same rules/LLM pipeline, with `when: { type: reaction }` available for dedicated rules. The original message body excludes Teams reaction badges, so a reaction does not replay a direct-message/mention alert. Badges currently expose reaction type/count but not the reactor's identity: synthetic text says “Someone added 👍 to Alex's message …” rather than guessing a name. Metadata includes the original author/text/time and observation time. Own reaction count changes are excluded. Existing reactions are baselined on first observation each activation. One previously observed chat is revisited per poll after unread chats; this only covers the visible 15-message tail, not every historic reaction, and count-preserving swaps between people cannot be detected. New reactions to older messages can be handled after a baseline, but ordinary messages predating orchestrator activation (or missing a valid time) are skipped. Explicit echo-loop testing bypasses that cutoff.

**System logs** includes orchestrator output, connection/delivery events, tunnel output, and raw message activity. `access_token`/`GUI_TOKEN` values are not intentionally exposed by the diagnostics API. Each FCM HTTP attempt logs its start, Firebase acceptance/failure, duration, generation and alertId, without message contents or credentials. The phone logs receipt before reconciliation, SDK sent time/original and delivered priority, receipt device state, and the same alertId through notification/alarm decisions. Cross-device latency is approximate because clocks may differ; Firebase acceptance is not delivery confirmation. Android diagnostics supports confirmed deletion before a local date/time or older than a selected age, independently of export filters; malformed/undated records are retained.

## Android app

See `android-app/README.md` for FID registration, fallback behavior, health policy, diagnostics, and local builds.

Download the [latest published Android APK](https://github.com/GuyMichaely/teams-monitor/releases/download/android-latest/teams-monitor.apk) on the phone. The Android APK GitHub Action builds and publishes on Android changes pushed to `main`, or when run manually. It is the only retained GitHub Actions workflow.

The public download URL [gui.guymichaely.com/app-debug.apk](https://gui.guymichaely.com/app-debug.apk) redirects to the latest GitHub APK; no local build is required. Local builds remain supported for USB installation; see `android-app/README.md`.

## Local validation

Development and validation are local; Android APK publishing is the GitHub Actions exception. From the repository root:

```powershell
bun scripts/smoke-alert-state.mjs
bun scripts/smoke-config-yaml.mjs
bun scripts/smoke-health.mjs
bun scripts/smoke-gui.mjs
bun scripts/smoke-dashboard.mjs
bun scripts/smoke-presence.mjs
bun scripts/smoke-self-messages.mjs
bun scripts/smoke-activity-view.mjs
bun scripts/smoke-dashboard-activity.mjs
bun scripts/smoke-brain-policy.mjs
bun scripts/smoke-rule-evaluation.mjs
bun scripts/smoke-rule-policy.mjs
bun scripts/smoke-rule-execution.mjs
bun scripts/smoke-message-metadata.mjs
bun scripts/smoke-reactions.mjs
bun scripts/smoke-fcm-timing.mjs
bun scripts/smoke-websocket-lifecycle.mjs
```

These checks exercise persisted alert delivery, health transitions, an authenticated GUI/WebSocket handshake, reply permission enforcement, and poll reporting. Each script creates its own temporary configuration and data directory; live registrations and runtime state are untouched. `bun scripts/smoke-dashboard.mjs --serve` keeps an isolated preview with fictional messages on port 18091 for browser checks. For Android changes, run the local build described in `android-app/README.md`. For optional Worker changes, use the local dry-run instructions in `cloudflare-worker/README.md`.

## Safety / operational notes

- `config/config.yaml`, `context/user-profile.md`, `.env`, Firebase credentials, and `data/` are ignored local/runtime state.
- Keep reusable non-secret defaults in the tracked `*.example.*` files.
- The monitor can restart Teams to expose its debugging port.
- The Cloudflare GUI uses `GUI_TOKEN`; stopping the tunnel while using `gui.guymichaely.com` disconnects that remote session and WebSocket alert path.
- Stop the orchestrator with the GUI Stop button or `bun src/cli.mjs stop`.
- Teams DOM selectors can break when Microsoft changes the client.
