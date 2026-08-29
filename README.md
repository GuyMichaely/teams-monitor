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

- `config/config.json` — runtime settings changed by the GUI, including polling interval and preferred alert transport.
- `context/user-profile.md` — freeform context/instructions supplied to the brain.

On first run, missing local files are automatically copied from `config/config.example.json` and `context/user-profile.example.md`. Edit the live files, not the tracked examples, for machine-specific settings that should survive `git pull`.

## Normal startup

From the repo root:

```powershell
bun run gui
```

This starts the management GUI on the port configured in the local `config/config.json` (8090 in the example). From the dashboard you can start/stop the monitor and start/stop the existing `teams-gui` Cloudflare tunnel.

To run the monitor directly without the GUI:

```powershell
bun start
```

The all-in-one Windows launcher remains available:

```powershell
.\scripts\start-stack.ps1
```

It starts the GUI, orchestrator, and existing Cloudflare tunnel when each is not already running.

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
src/gui-server*.mjs            dashboard, API, WebSocket alert hub, diagnostics
src/state.mjs                  runtime state/activity under data/
config/config.example.json     tracked configuration template
config/config.json             gitignored live configuration
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
- One successful preferred-path recovery returns the system to its configured primary.
- FCM retryable 429/5xx failures respect `Retry-After`/backoff state instead of repeatedly hitting FCM.
- An invalid FCM registration is treated as a recovery event immediately rather than consuming the normal transient-failure budget.

When FCM is primary, WebSocket can therefore remain cold during normal operation and run temporarily during recovery. A periodic silent FCM recovery check is controlled by `alerts.failover.recoveryCheckIntervalMs`.

FCM registration state lives in gitignored `data/fcm-registration.json`. The deprecated `data/fcm-device-token.txt` is retained only as a migration compatibility path.

### Optional control Worker

`cloudflare-worker/` contains an optional Cloudflare Worker backed by a SQLite Durable Object. It is **disabled by default** and is not part of normal Teams-message delivery. Its purpose is an independent control/recovery plane:

- mirror PC and phone control state;
- mirror the phone's current FID;
- receive an orchestrator heartbeat;
- detect heartbeat loss independently of the home tunnel;
- issue high-priority FCM recovery/health control messages when useful.

The Android app performs a roughly 15-minute WorkManager safety synchronization. It tries the direct PC endpoint first and uses the Worker when configured and necessary; direct success also mirrors state to the Worker so its shadow copy stays current.

See `cloudflare-worker/README.md` for deployment/secrets. `controlWorker.enabled` remains `false` until a Worker is actually deployed and its URL is configured.

## GUI diagnostics

The dashboard has **Connection diagnostics** with Refresh/Copy controls plus a live pipeline timeline. It records WebSocket connection/rejection/disconnection events and includes redacted Cloudflare tunnel logs. `access_token`/`GUI_TOKEN` values are not intentionally exposed by the diagnostics API.

## Android app

See `android-app/README.md` for FID registration, fallback behavior, watchdog policy, diagnostics, and local builds.

The repository also has `.github/workflows/android-apk.yml`. Android changes automatically build a signed APK and publish it to the stable GitHub Release tag `android-latest`, while also retaining an Actions artifact when the signing secret is configured.

## CI guards

- `.github/workflows/bun-smoke.yml` runs on Windows, exercises the persisted alert-delivery state machine, and performs a real authenticated GUI/WebSocket handshake under Bun.
- `.github/workflows/android-apk.yml` compiles and publishes the Android companion app.
- `.github/workflows/cloudflare-worker-smoke.yml` performs a Wrangler dry-run of the optional control Worker without deploying it.

## Safety / operational notes

- `config/config.json`, `context/user-profile.md`, `.env`, Firebase credentials, and `data/` are ignored local/runtime state.
- Keep reusable non-secret defaults in the tracked `*.example.*` files.
- The monitor can restart Teams to expose its debugging port.
- The Cloudflare GUI uses `GUI_TOKEN`; stopping the tunnel while using `gui.guymichaely.com` disconnects that remote session and WebSocket alert path.
- Stop the orchestrator with the GUI Stop button or `bun src/cli.mjs stop`.
- Teams DOM selectors can break when Microsoft changes the client.
