# AGENTS.md — project knowledge transfer

Read this before touching anything. It captures architecture, operational procedures, and user decisions that are not necessarily obvious from individual files.

## What this is

A personal Microsoft Teams monitoring/alerting system. It drives the new Teams desktop client (MSIX/WebView2) over the Chrome DevTools Protocol, triages incoming messages with an LLM, and alerts the user's Android phone. Single user, runs on a Windows laptop, not a product. Priorities: reliable alerting > cautious automation > elegance.

## Architecture map

```text
src/
  teams.mjs         Teams WebView2/CDP core on port 9222.
  monitor.mjs       Unread detection + chat reading.
  brain.mjs         Gemini decision layer.
  orchestrator.mjs  Poll → read → dedupe → decide → act → log. Writes real tick heartbeat.
  actions.mjs       Action registry including alert_phone.
  alerts.mjs        Preferred/fallback FCM + WebSocket delivery and recovery.
  alert-runtime.mjs Persisted transport/FID generation/failure/backoff state.
  worker-control.mjs Optional Cloudflare Worker control-plane client.
  tunnel-health.mjs PC-side public tunnel probe when Worker is disabled.
  phone-health.mjs  Direct high-priority FCM health-transition sender.
  gui-server*.mjs   Dashboard, API, WebSocket alert hub and diagnostics.
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

Worker secrets: `CONTROL_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. CI performs only a Wrangler dry run and never deploys.

## Android health behavior

PC-heartbeat and public-tunnel incidents are separate state machines using the same user-selected policy:

- `notify` (default)
- `alarm_now`
- `alarm_after_delay`
- `ignore`

Recovery clears only the matching incident, cancels only its delayed work and stops only health-watchdog audio owned by that incident. It must not silence a Teams alert alarm or another still-active health incident.

Health state can arrive by Worker FCM push, Worker safety poll, or (with Worker disabled) direct PC FCM tunnel-transition push.

## Current operating decisions

- Automation mode is alert-only: Gemini decides alarm vs ignore; orchestrator does not send Teams replies in this mode.
- Direct 1:1 chats and name-addressed messages have deterministic alarm backstops.
- Runtime is Bun 1.4+.
- Normal startup: `bun run gui`; direct orchestrator: `bun start`; all-in-one: `scripts/start-stack.ps1`.
- `GUI_TOKEN` is the selected GUI/WS/control auth layer; Cloudflare Access was rejected.
- Task Scheduler/autostart was blocked/rejected. Do not add it back without a new decision.
- After server changes, restart long-running GUI/orchestrator processes.

## Hard-won gotchas

1. Teams unread often does not clear; `processChat` dedupes latest message against prior `lastSeen`.
2. Self-chat is a test harness; `alerts.ignoreAuthors` is intentionally empty.
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
- GitHub Actions: `ANDROID_DEBUG_KEYSTORE_BASE64`, `FIREBASE_GOOGLE_SERVICES_JSON_BASE64`.
- optional Worker secrets listed above.
- `~/.cloudflared/`: local tunnel credentials.

## Conventions / status

- Main server intentionally has zero npm dependencies; use Bun/Node-compatible built-ins.
- ESM `.mjs`, terse WHY-comments; Android uses Views/appcompat + OkHttp + WorkManager.
- Keep Bun, Android and Worker smoke workflows green when touching their domains.
- FID + hybrid FCM/WS fallback/recovery, generation isolation, separate heartbeat/tunnel health and optional Worker are implemented.
- Worker live deployment and real-device FCM/failover tests are operational steps, not CI-proven behavior.
- TFS integration remains disabled/un-deployed.
