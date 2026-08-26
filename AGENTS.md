# AGENTS.md — project knowledge transfer

Read this before touching anything. It captures architecture, hard-won gotchas,
operational procedures, and decisions the user made (often for reasons that
aren't obvious from the code).

## What this is

A personal Microsoft Teams monitoring/auto-responding system. It drives the
new Teams desktop client (MSIX/WebView2) over the Chrome DevTools Protocol,
triages incoming messages with an LLM, and alerts the user's phone via an
Android companion app. Single user (Guy), runs on his Windows laptop, not a
product. Priorities: reliable alerting > cautious automation > elegance.

## Architecture map

```
src/
  teams.mjs         CDP core. Connects to Teams' WebView2 debug port (9222), restarts
                    Teams with the port if missing. listChats/setUnreadFilter/openChat/
                    readOpenChat/sendMessage/watchMessages. Selectors are data-tid-based
                    and break on Teams updates — re-inspect the DOM if reads/sends fail.
  monitor.mjs       Unread detection via Teams' own "Unread" rail filter + open/read a
                    chat. THE UNREAD FILTER IS LEFT ON during monitor runs (user decision:
                    Teams isn't used for anything else while monitoring; no restore on exit).
  brain.mjs         Decision contract: {action: respond|hold|escalate, reply, invokeActions,
                    reason}. Providers: stub (rule-based), gemini (implemented), anthropic/
                    openai (seams only). Prompt treats message content as UNTRUSTED data
                    (prompt-injection isolation) — keep it that way.
  orchestrator.mjs  The loop: poll unread → readChat → dedupe → brain.decide → act → log.
                    Exports hardStop() (break-glass kill via heartbeat pid, refuses stale
                    heartbeats) and isAddressed() (name-mention matcher).
  actions.mjs       Action registry (the brain's "tools") + console escalate().
                    alert_phone is registered here; transports live in alerts.mjs.
  alerts.mjs        Phone-alert transports: "websocket" (POST to GUI hub /api/alerts) or
                    "fcm" (Firebase direct, hand-rolled service-account OAuth — configured
                    but never used yet).
  gui-server.mjs    Dashboard SPA + JSON API + WebSocket alert hub (/ws/alerts, hand-rolled
                    RFC6455) + APK download (/app-debug.apk, PUBLIC by user decision) +
                    /api/profile (live brain-context editor). Token auth: env GUI_TOKEN,
                    timing-safe compare; WS takes ?access_token=.
  state.mjs         state.json (per-chat firstReadByClaude + lastSeen) + activity.jsonl audit.
  context.mjs       Loads config/config.json + context/user-profile.md.
  cli.mjs           Entry point: run / stop / gui / catchup / chats / unread / readchat /
                    read / send / watch.
  integrations/     TFS dispatcher (tfs-server.mjs, tfs-queue.mjs) — code-complete,
                    DISABLED in config, see tfs-agent/ section below.
android-app/        Kotlin companion app (see its own README + the Android section below).
tfs-agent/          VM-side TFS worker — code-complete, NEVER deployed, NEVER tested
                    against live TFS. run_agent_task is an unimplemented TODO.
scripts/
  start-stack.ps1   THE canonical startup: starts GUI + orchestrator + cloudflared tunnel,
                    each only if not already running (safe to re-run). Bun loads GUI_TOKEN
                    and GEMINI_API_KEY from the repo-root .env file.
  launch-teams.ps1  Manual Teams launch with debug port.
config/config.json  Live tracked config. Never put secrets here; Gemini uses the env var
                    named by brain.apiKeyEnv (currently GEMINI_API_KEY).
context/user-profile.md  The brain's user context, editable live from the dashboard.
data/               Runtime state (gitignored): state.json, activity.jsonl, logs,
                    heartbeat.json, STOP file.
tools/              Gitignored local toolchain: jdk17, android-sdk, gradle (for local APK builds).
.github/workflows/android-apk.yml  Builds Android debug APKs with the dev PC's stable debug key;
                    publishes the android-latest GitHub Release + Actions artifact.
.github/workflows/bun-smoke.yml  Windows Bun runtime test covering child_process + GUI WebSocket.
FEATURES-TODO.md    Backlog with design notes (response-policy rework, org hierarchy,
                    GUI-as-avatar, companion app status, known gaps).
```

## Running state & operations

- Automation mode is currently **alert-only**: Gemini decides `alarm` vs `ignore`; the orchestrator never sends Teams replies in this mode, even if a whitelist entry exists. Direct 1:1 chats and name-addressed messages have deterministic alarm backstops.
- Server runtime is **Bun 1.4+**, not Node. Relevant Node-compatible built-ins are used
  through Bun; keep the Windows Bun smoke workflow passing.
- Three long-running processes, all started by `scripts/start-stack.ps1`:
  GUI server (`bun src/cli.mjs gui`, port 8090, bound 0.0.0.0), orchestrator
  (`bun src/cli.mjs run`), cloudflared (`tunnel run teams-gui` →
  https://gui.guymichaely.com). Windows Firewall has an inbound allow rule for
  TCP 8090 (LAN access for the phone).
- Normal interactive startup is `bun run gui`; the GUI can start/stop the orchestrator
  and the existing teams-gui Cloudflare tunnel. `bun start` runs the orchestrator directly.
- Stop the orchestrator: `bun src/cli.mjs stop` (hard kill via heartbeat pid;
  the STOP file is a fallback). GUI Stop button does the same.
- Starting the orchestrator may RESTART the user's Teams (to get the debug
  port). That's inherent; don't try to avoid it.
- Rebuild the APK locally (toolchain is in-repo, gitignored):
  ```bash
  cd android-app
  export JAVA_HOME="C:/Users/GuyMichaely/projects/teams-monitor/tools/jdk17"
  export ANDROID_HOME="C:/Users/GuyMichaely/projects/teams-monitor/tools/android-sdk"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  cmd //c "gradlew.bat assembleDebug --no-daemon"
  ```
  The GUI serves the result at /app-debug.apk immediately (no copy step).
- Preferred Android distribution is the `android-latest` GitHub Release. CI runs
  `assembleDebug` and restores `%USERPROFILE%\.android\debug.keystore` from the
  `ANDROID_DEBUG_KEYSTORE_BASE64` Actions secret. Initial secret setup is done manually
  in GitHub's web UI; no `gh` helper script is retained in the repo.
- After editing server code, restart processes so Bun reloads `.env`. The orchestrator
  needs GUI_TOKEN too: alert POSTs to the hub are authenticated.

## Hard-won gotchas (do not rediscover these)

1. **Teams' unread flag often never clears** when the monitor opens a chat
   (self-chat always; some group chats). Without protection the loop
   reprocesses — and re-bills the LLM for — the same message every tick.
   `processChat` dedupes: if latest == state.chats[chat].lastSeen
   (time+author+text), skip. echoLoop mode is exempt ON PURPOSE.
2. **Self-chat is the test harness**: message yourself in Teams to generate an
   unread. `alerts.ignoreAuthors` currently [] — the user emptied it for
   testing and never asked to restore it. Don't "fix" it silently.
3. **Orchestrator has died silently** a few times (no halt line, stale/no
   heartbeat). Root cause never confirmed (machine sleep/reboot suspected;
   heartbeat write is guarded now). start-stack.ps1 is the recovery path.
4. **Gemini free tier quirks**: retired models 404 (2.5-flash*), 2.0-flash
   429s on quota. Currently `gemini-3.1-flash-lite`. If it breaks:
   `GET https://generativelanguage.googleapis.com/v1beta/models` with the key
   to list what's live. Free tier may train on prompts — the user accepted
   this; colleagues' messages are in prompt content.
5. **Brain → phone alerting is two-layer**: the prompt tells the model to
   invoke alert_phone on escalate AND whenever the user is addressed; a
   deterministic backstop (isAddressed over `alerts.mentionNames`) fires if the
   model didn't. Keep both layers.
6. **Android notification channels are immutable after creation.** The alerts
   channel is v2 (`alerts2`) and deliberately SILENT — the alarm is played by
   MediaPlayer (alarm stream) instead, which is why it works under DND and
   ignores notification volume. Never re-bake sound into the channel.
7. **ACCESS_NOTIFICATION_POLICY** must be in the manifest or the app doesn't
   appear in the system's DND-access list (cost us a debugging cycle).
8. **No boot receiver in the app** — deliberate user decision (AV-heuristic
   hygiene). After phone reboot, user opens the app once.
9. **usesCleartextTraffic was removed** — http URLs are unusable in the app
   by design; the tunnel (https) is the path. `adb reverse` testing is dead.
10. **Cloudflare Access was considered and rejected** (user chose option A):
    GUI_TOKEN only. Dashboard stores it in localStorage (indefinite). Don't
    re-litigate unless the user asks.
11. **Task Scheduler is blocked** by corporate policy on this machine; the
    Startup-folder autostart was tried and REMOVED at the user's request —
    they start the stack themselves. Don't add autostart back.
12. PowerShell via Git Bash: bash eats `$env:` in double-quoted
    `-Command "..."` strings — use single quotes. We lost a server restart to
    this (came up without GUI_TOKEN, open).
13. Alert dedupe relies on `state.json` lastSeen; `markFirstRead` overwrites
    it — capture prevSeen BEFORE calling it (see processChat).
14. Sending requires a focused compose box; `sendMessage` returns reason
    strings, not exceptions. `readChat` marks the chat read (inherent to the
    GUI-hook approach).
15. **Runtime data must never be committed.** A Cloudflare tunnel log once exposed
    a WebSocket access token through the query string. `data/` is gitignored and GUI
    diagnostics redact `access_token`; preserve both protections.
16. **Android update signing must stay stable.** CI intentionally uses the same
    `%USERPROFILE%\.android\debug.keystore` as local `assembleDebug` builds. Losing or
    replacing that key prevents future APKs from updating the installed app.
17. **Android alert reliability is auditable now.** `AppLog.kt` keeps a rolling app-private
    log, `AlertService` writes 15-minute heartbeats and detailed WS lifecycle failures,
    and the main screen has Copy diagnostics. The OkHttp WebSocket sends a ping every
    30 seconds so stale half-open sockets fail into the existing reconnect loop.

## Secrets inventory

- `.env` (gitignored) holds local `GUI_TOKEN` and `GEMINI_API_KEY`. Bun package scripts
  explicitly load it. Do not restore tracked secrets or runtime logs.
- `GUI_TOKEN` guards /api/*, /ws/alerts, dashboard overlay. (Not /app-debug.apk — public
  by decision.) The phone must use the same value.
- `GEMINI_API_KEY` is named by `brain.apiKeyEnv` for local brain calls.
- GitHub Actions Android signing secret: `ANDROID_DEBUG_KEYSTORE_BASE64`, containing
  the dev PC's `%USERPROFILE%\.android\debug.keystore` encoded as Base64.
- `config/fcm-service-account.json` — expected path for FCM (gitignored),
  doesn't exist yet; FCM never set up.
- `TFS_AGENT_TOKEN` — env var for the TFS dispatcher (disabled).
- `~/.cloudflared/` — tunnel credentials (config.yml, cert, <uuid>.json).

## Conventions

- Zero npm dependencies for the server; Bun 1.4+ runs the Node-compatible built-ins.
  Keep it dependency-free unless there's a strong reason.
- ESM (.mjs), terse comment style explaining WHY not WHAT. Comments live in
  file headers and above non-obvious blocks.
- The app allows OkHttp; no Compose, plain Views, appcompat.
- Minimal diffs; match surrounding style; don't refactor opportunistically.
- Don't run git mutations without explicit instruction.
- data/ is gitignored. config/config.json is tracked and must never contain secrets.

## Where things stand / likely next steps

- Whitelist (`whitelist.autoSend`) is EMPTY — nothing can auto-send; the
  brain drafts/holds/alerts only. Widening it is the user's explicit call.
- The response-policy rework (risk tiers replacing the whitelist), org-chart
  awareness, and GUI-as-avatar ideas are in FEATURES-TODO.md with design notes.
- FCM is the planned endgame alert transport (battery-proof); server side is
  written, Firebase project doesn't exist yet, app seam is AlertNotifier.alert().
- TFS integration: deploy tfs-agent/ on the VM + live-test + implement
  run_agent_task. Untouched for a while.
- user-profile.md is mostly template — the brain is triaging with thin
  context until the user fleshes it out (dashboard editor makes this easy).
