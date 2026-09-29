# Next task: process supervision and exit diagnostics

This is a context-compaction handoff, not an instruction to start implementation immediately. The user plans to compact, then ask to implement. Read current AGENTS.md and inspect current files/processes before acting.

## User intent

The GUI has disappeared repeatedly without useful crash logs. Add evidence that distinguishes application exceptions, native crashes, normal exits, external termination, and a live-but-unresponsive process as far as the platform allows. Do not call an unexplained exit a confirmed crash.

Proposed layers discussed with the user:

1. Application lifecycle/fatal logging: startup PID, version/revision, run identity, uncaught exceptions with stacks, unhandled rejections, shutdown signals and normal exits. Persist fatal records synchronously; preserve normal fatal termination semantics rather than keeping a broken process alive. Prevent duplicate recording and never log secrets.
2. An independent, manually launched supervisor: retain stdout/stderr per run, observe child exit codes, uptime and last successful health check. Record process exit separately from health timeout. Bounded restart/backoff is proposed, not yet implemented; make intentional stop distinct from unexpected death and prevent restart loops/duplicate instances.
3. Optional Windows native crash dumps specifically for bun.exe. Dumps may contain secrets/message contents: local-only, bounded storage, never commit/upload automatically. Check Windows/Bun support and permissions before enabling persistent OS configuration; explain scope and get any needed user choice. Native dumps do not diagnose every forced kill/power failure.

No Task Scheduler, boot autostart, Windows service installation, Cloudflare Worker deployment, or new hosted workflows. These are not authorized by the supervisor proposal. Manual startup is sufficient. GUI supervision is the immediate need; do not automatically start the intentionally stopped orchestrator or silently expand to supervising every component.

## Incident evidence (September 28, 2026, America/New_York)

- GUI PID 39408 started at 22:06:06 local (2026-09-29T02:06:06Z).
- Last recorded activity was a successful phone control sync at 22:30:47 local.
- At about 22:41 local: no bun.exe process, no listener on 8090. cloudflared PID 33432 remained alive. Local connection refused; public https://gui.guymichaely.com/ returned 502.
- data/gui-20260928-220605.log contained only startup output (74 bytes); corresponding .out.log was empty. No exit/exception entry appeared in data/gui-diagnostics.jsonl.
- Windows Application events 1000/1001 from the preceding hour had no match for bun.exe/teams-monitor. LastBootUpTime was September 26, not an intervening reboot.
- Cause remains unknown. Do not assert a Bun crash, OOM, Codex cleanup, or external killer without further evidence.
- Existing startup uses PowerShell Start-Process with hidden window. Hiding a window does NOT prove independence from a parent Windows job object. Investigate actual process lifetime and supported manual launch paths; do not assume spawn(detached) solves Windows job lifetime.

## Current operations (recheck; PIDs are historical)

- User authorized restarting GUI only; orchestrator remains stopped.
- Most recent successful restart launched GUI PID 30448 using:
  `bun --env-file=.env src/cli.mjs gui`
  from `C:\Users\GuyMichaely\projects\teams-monitor`.
- Start-Process used `-WindowStyle Hidden` and fresh timestamped `data/gui-*.log` / `.out.log` files so previous evidence remained intact.
- Local http://127.0.0.1:8090/ and public https://gui.guymichaely.com/ both returned HTTP 200 afterward.
- One earlier compound tool command was rejected by the command runner before execution. This was NOT a PowerShell execution-policy error. Subsequent ordinary read checks and standalone Start-Process worked. Do not tell the user they lack filesystem permissions or change Windows execution policy based on that rejection.

## Likely implementation/validation points

- Inspect src/cli.mjs, GUI startup/shutdown, orchestrator lifecycle and scripts/start-stack.ps1 before choosing integration points.
- Use a cheap bounded local HTTP liveness probe independent of Teams CDP and the public tunnel. A dead tunnel is not a dead GUI. Persist timestamps/latency, child PID and run ID; do not treat a health timeout alone as proof of a crash.
- Capture child exit independently of application code, with raw numeric exit status (including meaningful Windows representation). Record supervisor-requested termination explicitly.
- Keep crash evidence before restarting. Use bounded log rotation; avoid truncating the previous run. Never dump full environment, credentials, auth headers, or message contents into lifecycle records.
- Intentional GUI stop and supervisor stop must remain stopped. Existing GUI start/stop semantics for the orchestrator must not be undermined by a supervisor blindly restarting it.
- Validate normal exit, thrown exception, rejected promise, external child termination, startup failure/occupied port, hung health endpoint, restart limits/backoff and intentional stop. All tests must use isolated temporary state; import scripts/smoke-env.mjs before application modules. Do not test crashes by killing the user's live GUI.
- Restart only the relevant long-running process after implementation. Verify local/public availability separately. Real observation is still needed; tests cannot promise protection against all Windows termination cases.

## Repository/checkpoint situation

Recent commits ARE pushed to main:

- b394a34 — phone transport status and actual fallback policy (latest at handoff).
- 42b755f — silent FCM wake-up for switching to WebSocket.
- 4d877dc / b596a9a — corrected gui.guymichaely.com mobile default, default token h, URL normalization.
- Android APK workflow succeeded for b394a34 (run 36510999236) and published android-latest/teams-monitor.apk with the stable signing key.

However, substantial earlier PC-side work remains uncommitted/untracked: dashboard redesign, YAML config migration, unified automation/agent permissions, Teams presence controls, reactions, message filtering, WebSocket lifecycle cleanup, tests/docs, and removal of non-Android hosted workflows. The running PC uses this working tree, not merely origin/main. Recent commits deliberately staged only their own changes to preserve that backlog.

At handoff, HEAD and the local origin/main tracking ref both point to b394a34 (0 ahead/0 behind). That does NOT mean the working tree is clean or backed up remotely. Recheck remote and status before committing.

Recommended next checkpoint workflow: review/classify the pending diffs, inspect untracked files (especially advanced_format.txt and note to self.txt; do not blindly publish personal scratch files), verify ignore rules/secrets, run relevant isolated smoke tests, then commit coherent complete changes and push if authorized. Do not use git add -A blindly or push partial dependency chains. Keep runtime data, live YAML/profile, .env, Firebase config/credentials and signing material ignored.

The user asked whether commits/pushes should be more frequent; recommendation is yes, at tested logical milestones. Asking this question was not itself blanket authorization to publish the entire old backlog. This handoff file was created locally for compaction and has not yet been committed.

## Recent phone-control details not yet fully reflected in AGENTS.md

- Delivery saves broadcast policy to connected WebSockets and send a silent high-priority FCM control message with `actions=sync_policy`, 60-second TTL and collapse key delivery-policy-sync. It carries no old transport selection. Android fetches current authenticated /api/control/sync on receipt.
- requestPhonePolicySync in src/alerts.mjs honors persisted FCM backoff and logs accepted/deferred/failed. API acceptance must not mark WebSocket healthy or prove receipt. No Cloudflare Worker required.
- Phone fetches policy on opening the app, on socket connection/control, and via periodic WorkManager sync. FCM delay/background restrictions can delay a switch.
- Android now persists fallbackTransport and FCM registration status, displays both transports through DeliveryStatus.kt, and refreshes on preference changes. Disabled WebSocket differs from standby. FCM may remain control-only even with no FCM alert fallback.
- User reported an immediate launch crash after an earlier APK; uninstall/reinstall resolved it. They explicitly requested undoing that investigation. No crash fix/test infrastructure had been changed then, so nothing was reverted. Do not resume that superseded investigation as part of supervision.
