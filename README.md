# teams-monitor

Personal Microsoft Teams monitoring/automation system. It drives the new Teams desktop client (WebView2) over the Chrome DevTools Protocol (CDP), triages unread messages, exposes a management GUI, and can alert the Android companion app through a Cloudflare Tunnel.

## Requirements

- Windows with the new Teams desktop client (`ms-teams.exe`).
- Bun 1.4+.
- An existing Cloudflare Tunnel named `teams-gui` if remote GUI/phone connectivity is wanted.

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

- `config/config.json` — runtime settings changed by the GUI, including polling interval and alert transport.
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
src/alerts.mjs                 phone-alert transports
src/gui-server*.mjs            dashboard, API, WebSocket alert hub, diagnostics
src/state.mjs                  runtime state/activity under data/
config/config.example.json     tracked configuration template
config/config.json             gitignored live configuration
context/user-profile.example.md tracked brain-profile template
context/user-profile.md        gitignored live brain context
android-app/                   Android companion app
tfs-agent/                     separate TFS worker integration
```

The GUI's `/ws/alerts` endpoint is the live alert channel used when WebSocket transport is selected. FCM can instead deliver Android alarms through Firebase Cloud Messaging.

## GUI diagnostics

The dashboard has **Connection diagnostics** with Refresh/Copy controls. It records WebSocket connection/rejection/disconnection events and includes redacted Cloudflare tunnel logs. `access_token`/`GUI_TOKEN` values are not intentionally exposed by the diagnostics API.

## Android app

See `android-app/README.md` for app behavior and local builds.

The repository also has `.github/workflows/android-apk.yml`. Android changes automatically build a signed APK and publish it to the stable GitHub Release tag `android-latest`, while also retaining an Actions artifact when the signing secret is configured.

## Bun compatibility guard

`.github/workflows/bun-smoke.yml` runs on Windows and starts the real GUI under Bun, then performs an authenticated WebSocket handshake against `/ws/alerts`. This keeps the Node-compatibility-sensitive part of the server under CI instead of relying on assumption alone.

## Safety / operational notes

- `config/config.json`, `context/user-profile.md`, `.env`, Firebase credentials, and `data/` are ignored local/runtime state.
- Keep reusable non-secret defaults in the tracked `*.example.*` files.
- The monitor can restart Teams to expose its debugging port.
- The Cloudflare GUI uses `GUI_TOKEN`; stopping the tunnel while using `gui.guymichaely.com` disconnects that remote session.
- Stop the orchestrator with the GUI Stop button or `bun src/cli.mjs stop`.
- Teams DOM selectors can break when Microsoft changes the client.
