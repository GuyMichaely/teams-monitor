# AGENTS.md — project knowledge transfer

Read this before touching anything. It captures architecture, hard-won gotchas,
operational procedures, and user decisions that are not necessarily obvious from
individual files.

## What this is

A personal Microsoft Teams monitoring/alerting system. It drives the new Teams
desktop client (MSIX/WebView2) over the Chrome DevTools Protocol, triages incoming
messages with an LLM, and alerts the user's Android phone. Single user, runs on a
Windows laptop, not a product. Priorities: reliable alerting > cautious automation >
elegance.

## Architecture map

```text
src/
  teams.mjs         CDP core. Connects to Teams' WebView2 debug port (9222), restarts
                    Teams with the port if missing. listChats/setUnreadFilter/openChat/
                    readOpenChat/sendMessage/watchMessages. Selectors are data-tid-based
                    and can break on Teams updates.
  monitor.mjs       Unread detection via Teams' own Unread rail filter + open/read chat.
                    The unread filter is deliberately left on during monitor runs.
  brain.mjs         Decision contract + Gemini provider. Message content is treated as
                    untrusted prompt data; preserve that isolation.
  orchestrator.mjs  Poll → read → dedupe → brain.decide → act → log. Writes a heartbeat
                    every real loop tick; exports hardStop() and isAddressed().
  actions.mjs       Action registry. alert_phone is registered here.
  alerts.mjs        Preferred/fallback phone delivery over FCM and WebSocket. Assigns
                    alertId, performs per-alert fallback, persisted failover/recovery,
                    FCM error classification and Retry-After/backoff handling.
  alert-runtime.mjs Shared gitignored delivery state: active/preferred transport,
                    failure counts, FCM registration/FID health, retry backoff and
                    websocketWanted. Cross-process file lock + atomic writes.
  worker-control.mjs Optional Cloudflare Worker control-plane client. Mirrors PC state,
                    heartbeat and phone registration when enabled.
  gui-server*.mjs   Dashboard SPA + JSON API + WebSocket hub (/ws/alerts) + APK download
                    + diagnostics + profile editor.
  state.mjs         state.json + activity.jsonl audit under gitignored data/.
  context.mjs       Loads gitignored config/config.json + context/user-profile.md,
                    bootstrapping them from tracked examples when missing.
  cli.mjs           run / stop / gui / catchup / chats / unread / readchat / read / send /
                    watch. run also schedules Worker heartbeat and transport recovery.
android-app/        Kotlin companion. FID registration, FCM, WS fallback, WorkManager
                    control sync, alertId dedupe, watchdog policy, diagnostics.
cloudflare-worker/  Optional independent control/recovery plane using a SQLite Durable
                    Object. Disabled by default and not part of normal Teams alert data.
tfs-agent/          VM-side TFS worker; code-complete but not live-tested/deployed.
scripts/
  start-stack.ps1   Canonical all-in-one startup for GUI/orchestrator/cloudflared.
  smoke-gui.mjs     Real Bun GUI/WebSocket runtime smoke.
  smoke-alert-state.mjs Persisted delivery/failover/backoff/concurrency smoke.
config/
  config.example.json  Tracked defaults copied to ignored config/config.json.
context/
  user-profile.example.md Tracked starter copied to ignored user-profile.md.
.github/workflows/
  android-apk.yml              builds/publishes Android debug APK.
  bun-smoke.yml                Windows Bun + alert state + real WS smoke.
  cloudflare-worker-smoke.yml  Wrangler dry-run; never deploys.
FEATURES-TODO.md    Backlog/design notes.
```

## Current phone-delivery architecture

`config.alerts.transport` is the **preferred primary**, not an exclusive mode.
Both FCM and WebSocket are delivery capabilities.

### FCM

- New registrations use Firebase Installation IDs (FIDs).
- Android opts into the new FID registration system and handles
  `FirebaseMessagingService.onRegistered(fid)`.
- Firebase auto-init owns routine registration freshness; explicit
  `FirebaseMessaging.register()` is a recovery operation only.
- The phone persists the FID before network sync, uploads it to the PC and durably
  retries failed direct uploads with WorkManager.
- PC stores current registration in `data/fcm-registration.json`.
- `data/fcm-device-token.txt` remains only as a one-release/deprecated-token migration
  path. Do not build new logic around it.
- PC sends directly to Firebase HTTP v1 with `message.fid` for FIDs.
- Normal FCM delivery does not need the GUI or Cloudflare Tunnel once the PC has the FID.

### WebSocket

- Orchestrator POSTs to local GUI `/api/alerts`; GUI broadcasts `/ws/alerts`.
- A remote phone reaches that WebSocket through the existing Cloudflare Tunnel.
- If WebSocket is primary, Android keeps the foreground `AlertService` running.
- If FCM is primary, WS can stay cold and start temporarily for recovery/fallback.
- Existing reconnect policy: OkHttp ping 30s, exponential reconnect 1/2/4/... capped
  at 60s, `START_STICKY` foreground service.
- There is deliberately no boot receiver; after reboot the app must be opened once.

### Failover/recovery

- Every alert gets an `alertId`; Android dedupes recent IDs across both transports.
- In healthy/retrying state, preferred transport is tried first. On failure the
  alternate can carry that individual alert immediately.
- Configurable consecutive preferred failures enter persisted `fallback` state.
- In fallback, alternate transport is tried first; preferred is then tested with the
  same alertId, so a recovery copy cannot double-ring.
- One preferred-path success restores `primary_working`.
- Definitive FCM registration errors bypass the transient failure budget.
- FCM 429/5xx failures persist retry/backoff state and honor `Retry-After` where
  available. Alerts during backoff use alternate delivery without manufacturing extra
  FCM failure counts.
- A periodic silent FCM recovery control send runs while FCM is configured primary and
  degraded (`alerts.failover.recoveryCheckIntervalMs`, 30s in the example). Firebase
  acceptance is the current recovery criterion; successful recovery tells Android to
  stop temporary WS.

Important FCM error rule: **do not equate arbitrary HTTP 404 with an invalid phone
registration**. Inspect FCM-specific error details. `UNREGISTERED` is the definitive
stale registration signal. `INVALID_ARGUMENT` is registration-specific only when the
FCM error detail says so / payload validity is otherwise established.

## Optional Cloudflare control Worker

`cloudflare-worker/` is optional and `controlWorker.enabled` defaults false.
It is a control/recovery/watchdog plane, not the normal Teams-message alert path.

When enabled:

- PC mirrors alert/control state and its real orchestrator heartbeat.
- phone mirrors current FID and WS state even when direct PC sync succeeds;
- Worker Durable Object tracks PC/phone state and heartbeat incidents;
- Worker alarm detects a stale PC heartbeat independently of the home tunnel;
- Worker can send high-priority FCM `control`/`health` messages to the phone;
- phone still has a ~15-minute WorkManager safety reconciliation that tries direct PC
  first, then Worker when necessary.

Heartbeat semantics matter: Worker heartbeat is gated by freshness of the actual
`data/heartbeat.json` written by orchestrator ticks. A live but wedged CLI process must
not make the Worker think automation is healthy.

Worker storage/config:

- `ControlState extends DurableObject`.
- new namespace uses SQLite storage.
- tracked `wrangler.toml.example` uses declarative `[exports.ControlState]`.
- secrets: `CONTROL_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
  `FIREBASE_PRIVATE_KEY`.
- CI only runs `wrangler deploy --dry-run`; it never deploys.

## Android control/watchdog behavior

- `NotificationTransport` runs a roughly 15-minute WorkManager safety sync.
- direct `/api/control/sync` wins; Worker is fallback. Direct success also mirrors to
  Worker so the independent shadow remains current.
- FCM control pushes and Worker-poll state share the same recovery handlers.
- PC heartbeat incident policy is local Android state:
  - `notify` (default)
  - `alarm_now`
  - `alarm_after_delay`
  - `ignore`
- heartbeat recovery clears incident state, cancels delayed work and stops a watchdog
  alarm if one is currently playing.

## Running state & operations

- Automation mode is currently **alert-only**: Gemini decides alarm vs ignore; the
  orchestrator never sends Teams replies in this mode. Direct 1:1 chats and
  name-addressed messages have deterministic alarm backstops.
- Server runtime is **Bun 1.4+**, not Node.
- Normal interactive startup: `bun run gui`; GUI can start/stop orchestrator and the
  existing `teams-gui` tunnel.
- Direct orchestrator: `bun start`.
- All-in-one launcher: `scripts/start-stack.ps1`.
- Stop orchestrator: `bun src/cli.mjs stop` or GUI Stop.
- Starting orchestrator may restart Teams to expose CDP 9222.
- After server changes, restart the relevant long-running processes so Bun reloads code
  and `.env`.
- Orchestrator needs `GUI_TOKEN` too because WS-hub POSTs are authenticated.

Local Android build:

```bash
cd android-app
export JAVA_HOME="C:/Users/GuyMichaely/projects/teams-monitor/tools/jdk17"
export ANDROID_HOME="C:/Users/GuyMichaely/projects/teams-monitor/tools/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
cmd //c "gradlew.bat assembleDebug --no-daemon"
```

Preferred Android distribution is the stable `android-latest` GitHub Release. CI uses
the same debug signing key as local builds via `ANDROID_DEBUG_KEYSTORE_BASE64`.

## Hard-won gotchas

1. **Teams unread often does not clear.** `processChat` dedupes latest message against
   `state.chats[chat].lastSeen`; echoLoop is deliberately exempt.
2. **Self-chat is the test harness.** `alerts.ignoreAuthors` is currently empty; don't
   silently restore an ignore entry.
3. **Orchestrator has died silently before.** Root cause never confirmed. Heartbeat
   freshness now detects a wedged loop; startup script is still the recovery path.
4. **Gemini model availability/quota changes.** Current model is
   `gemini-3.1-flash-lite`.
5. **Brain → phone alerting is two-layer.** Model decision plus deterministic addressed
   backstop; preserve both.
6. **Android notification channels are immutable.** `alerts2` is deliberately silent;
   MediaPlayer on alarm stream makes the audible alarm.
7. **ACCESS_NOTIFICATION_POLICY must remain in the manifest** for DND access.
8. **No Android boot receiver** by deliberate decision.
9. **Cleartext traffic is disabled** by deliberate decision; HTTP app URLs are unusable.
10. **Cloudflare Access was rejected.** GUI_TOKEN is the chosen auth layer.
11. **Task Scheduler/autostart was rejected/blocked.** Do not add it back.
12. PowerShell via Git Bash can eat `$env:` in double-quoted `-Command` strings.
13. Capture previous `lastSeen` before `markFirstRead`; it overwrites the field.
14. Teams sends require focused compose; `sendMessage` returns reason strings rather
    than throwing.
15. **Runtime data must never be committed.** `data/` stays ignored; diagnostics redact
    access tokens.
16. **Android signing key must stay stable** or updates cannot replace installed APK.
17. **Android alert reliability is auditable.** Rolling AppLog, WS lifecycle logs,
    FID/control/recovery/watchdog events and diagnostics report exist.
18. **Alert IDs are a correctness primitive.** Do not remove cross-transport dedupe if
    changing failover behavior.
19. **FID is the current registration architecture.** Do not add new dependencies on
    deprecated `onNewToken()`/`.token` registration APIs.
20. **FCM backoff matters.** Honor Retry-After and persisted `nextAttemptAt`; do not make
    every incoming Teams alert hammer FCM during quota/service failures.
21. **Worker is optional.** Core FCM/WS operation must remain functional when
    `controlWorker.enabled=false`.
22. **Worker never gets Teams message contents in normal operation.** Keep it a small
    control/recovery plane unless the user explicitly chooses otherwise.

## Secrets inventory

- `.env` (ignored): `GUI_TOKEN`, `GEMINI_API_KEY`.
- `GUI_TOKEN`: guards GUI `/api/*`, `/ws/alerts`, dashboard overlay; also used as the
  default Worker control token when Worker is deployed.
- `GEMINI_API_KEY`: brain provider credential.
- `config/fcm-service-account.json` (ignored): PC-side Firebase service account.
- `android-app/app/google-services.json` (ignored): Android Firebase config.
- GitHub Actions: `ANDROID_DEBUG_KEYSTORE_BASE64`, `FIREBASE_GOOGLE_SERVICES_JSON_BASE64`.
- optional Worker secrets listed above; never place them in tracked Wrangler config.
- `TFS_AGENT_TOKEN`: disabled TFS integration.
- `~/.cloudflared/`: local tunnel credentials.

## Conventions

- Zero npm dependencies for the main server; Bun 1.4+ uses Node-compatible built-ins.
- ESM `.mjs`, terse WHY-comments, minimal diffs.
- Android: plain Views/appcompat + OkHttp + WorkManager; no Compose.
- Do not commit `data/`, `.env`, live config/profile or Firebase credentials.
- Live `config/config.json` and `context/user-profile.md` are gitignored and bootstrap
  from tracked examples. Do not re-track them.
- Keep Bun, Android and Worker smoke workflows green when touching their domains.

## Where things stand

- Alert-only automation is the active mode; whitelist is empty.
- FID + hybrid FCM/WS fallback/recovery is implemented.
- Optional Cloudflare Worker source/config and dry-run CI are implemented but live
  deployment/secrets remain an operational step; default config keeps it disabled.
- A real-phone end-to-end FID/failover test is still required after pulling/restarting
  the PC and installing the latest Android APK.
- TFS integration remains disabled/un-deployed.
