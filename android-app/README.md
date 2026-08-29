# Teams Monitor — Android companion app

Personal-use, sideloaded Android app for the Teams monitoring system in this repo.

## What it does

The native main screen shows WebSocket connection status, server URL, the last alert, quick alert toggles, and buttons for the web dashboard, Settings, battery-optimization exemption, alarm testing, and diagnostics export.

The server has two alert-delivery capabilities: WebSocket and Firebase Cloud Messaging (FCM). `alerts.transport` selects the **preferred** transport, not an exclusive mode. The alternate path can be used for an individual failed alert or as a temporary fallback after repeated preferred-path failures.

For either path, configure the server/control connection:

```text
Server URL: https://gui.guymichaely.com
Access token: same value as GUI_TOKEN on the laptop
```

The app converts that URL to the WSS alert endpoint when WebSocket is wanted and supplies the token as the WebSocket access token. Plain HTTP is intentionally unsupported.

Alerts can show a notification and/or play the alarm stream. Do Not Disturb bypass requires notification-policy access. There is deliberately no boot receiver; after reboot, open the app once.

## Delivery and recovery behavior

### FCM

FCM uses Firebase Installation IDs (FIDs), not the deprecated registration-token lifecycle, for new registrations:

- the manifest opts into FID-based FCM registration;
- `FirebaseMessagingService.onRegistered(...)` persists the latest FID immediately;
- Firebase auto-init owns routine FCM registration freshness;
- `FirebaseMessaging.register()` is used only as an explicit recovery action;
- the FID is uploaded to the PC and, when configured, mirrored to the optional control Worker;
- failed phone→PC registration uploads are retried durably with WorkManager.

The PC stores the current registration in gitignored `data/fcm-registration.json`. Each registration has a generation number so a delayed success/failure from an obsolete FID cannot change the health of a newer registration. The old `data/fcm-device-token.txt` path exists only for migration compatibility.

Normal FCM alert delivery goes directly from the orchestrator to Google FCM, so the GUI/tunnel do not need to be running once the PC has a usable FID.

When FCM has entered degraded/fallback state, successful Firebase HTTP acceptance does not by itself end recovery. The PC sends a silent recovery probe; Android persists the probe ID on receipt and synchronizes an ACK back through the direct control path or optional Worker. Only the matching ACK for the current registration generation lets the PC restore FCM primary and release temporary WebSocket. Android performs the immediate ACK sync plus one short follow-up WorkManager retry so an ACK cannot be delayed to the normal 15-minute safety cadence by a narrow timing race.

### WebSocket fallback

The foreground `AlertService` maintains `/ws/alerts` whenever WebSocket is the preferred transport or recovery state asks for it. With FCM primary, WebSocket can remain off normally and start temporarily when FCM is degraded.

The existing WebSocket behavior remains:

- OkHttp ping every 30 seconds;
- exponential reconnect delay capped at 60 seconds;
- `START_STICKY` foreground service;
- no boot receiver.

Android background-start restrictions can prevent an immediate foreground-service start in some circumstances; recovery state remains persisted and is retried through later control/app activity rather than breaking FCM registration recovery.

### Duplicate protection

Every server alert has an `alertId`. The app retains recent IDs and suppresses duplicate alarm/notification delivery across FCM and WebSocket. Transport-control metadata is still applied before duplicate suppression. A same-alert FCM copy can therefore serve as useful backend-acceptance evidence without ringing twice, but an FCM recovery state is not closed until the dedicated receipt probe is ACKed.

## Control synchronization and optional Worker

The phone periodically reconciles control state with WorkManager, approximately every 15 minutes:

1. try the direct PC `/api/control/sync` endpoint;
2. if unavailable and the optional Worker is configured, use the Worker;
3. when direct communication succeeds, also mirror current phone state to the Worker so its independent copy stays current.

This is a safety/recovery channel, not the normal alert-delivery path. Pending FCM recovery ACKs are also included in this control state, but they are synchronized immediately on probe receipt rather than waiting for the periodic job.

The optional Cloudflare Worker can tell the phone to re-register FCM or start/stop temporary WebSocket, can independently report loss of the PC/orchestrator heartbeat, and can probe the public GUI/tunnel URL from outside the home machine. It is disabled by default in the server configuration.

## Health watchdog

Settings include one local policy used for PC/orchestrator-heartbeat and public-tunnel incidents:

- **Show notification** — default;
- **Alarm immediately**;
- **Alarm after delay** — delay is configurable in minutes;
- **Ignore**.

Heartbeat and tunnel incidents are tracked separately. Recovery of one does not clear or silence the other. A recovery event clears that incident, cancels its pending delayed alarm, and stops only a health-watchdog alarm owned by that incident; it cannot stop a Teams alert alarm.

With the optional Worker enabled, heartbeat state and tunnel state can arrive by high-priority FCM health push or through the periodic Worker safety synchronization. The Worker performs the tunnel probe independently of the PC. With the Worker disabled, the PC self-probes the public URL and sends tunnel transition events over FCM when possible.

## Diagnostics

The app keeps a rolling diagnostic log in app-private storage. It records service lifecycle, WebSocket connection/reconnect/failure details, FID registration/synchronization, recovery/control activity, pending/confirmed FCM probe ACK state, received alert metadata, heartbeat/tunnel incidents, and notification/alarm delivery or suppression decisions. Access tokens are never intentionally logged, and URL-style `access_token` values are redacted before persistence.

Tap **Copy diagnostics** on the main screen to copy a report containing the recent log plus app/device version, current network state, battery-optimization status, notification permission/state, DND access, and relevant alert settings. Paste that report into a bug report or debugging chat.

The log is capped at roughly 1 MB and automatically retains the newest entries.

## Settings

Connection settings:

- Server URL
- Access token

Alert settings:

- Play alarm sound
- Show notification
- Alarm even when screen is on
- Use system alarm ringtone
- Alarm volume
- Alarm duration

Health-watchdog settings:

- health-incident policy
- delayed-alarm wait in minutes

The main screen's **Test alarm** button uses the current alarm settings and becomes **Stop alarm** while the sound is playing.

## Recommended install/update path: GitHub Release

The repository workflow `.github/workflows/android-apk.yml` runs the same `assembleDebug` build used locally. GitHub Actions restores the development PC's existing `%USERPROFILE%\.android\debug.keystore` first, so CI APKs have the same signature as local debug builds and can update the currently installed app.

One-time setup:

1. Confirm `%USERPROFILE%\.android\debug.keystore` exists. A local `assembleDebug` build creates it if necessary.
2. In PowerShell, copy it as Base64:

   ```powershell
   [Convert]::ToBase64String(
       [IO.File]::ReadAllBytes("$HOME\.android\debug.keystore")
   ) | Set-Clipboard
   ```

3. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
4. Name the secret `ANDROID_DEBUG_KEYSTORE_BASE64`, paste the clipboard value, and save it.
5. Open **Actions → Android APK → Run workflow** for the first published build.

No GitHub CLI is required.

**Back up `%USERPROFILE%\.android\debug.keystore`.** Android updates must continue to use the same signing key as the installed app.

After setup, Android-related pushes automatically refresh the `android-latest` GitHub Release and also store `teams-monitor.apk` as an Actions artifact. Download `teams-monitor.apk` from that Release on the phone and install it over the existing copy.

## Local build

Requirements are JDK 17, Android SDK 34, and Gradle 8.9 (the wrapper is checked in).

```powershell
cd android-app
.\gradlew.bat assembleDebug
```

Debug output:

```text
app\build\outputs\apk\debug\app-debug.apk
```

The local GUI also serves the current debug build at `/app-debug.apk` when that file exists.

## Testing

For WebSocket testing, run the GUI and tunnel, set the app's server URL to `https://gui.guymichaely.com`, and use the same access token as `GUI_TOKEN`.

Saving connection settings immediately runs a control synchronization and applies the current WebSocket policy. The dashboard WebView uses the same server URL.

FCM testing requires both Firebase configuration files:

- `android-app/app/google-services.json` — Android Firebase project configuration;
- `config/fcm-service-account.json` — PC credential used to call the FCM HTTP v1 API.

Both are intentionally untracked. GitHub Actions can embed `google-services.json` by restoring `FIREBASE_GOOGLE_SERVICES_JSON_BASE64`. If that secret is absent, the APK still builds and the WebSocket path remains available, but Firebase initialization is unavailable in that APK.

For a recovery test, force FCM into degraded/fallback state, confirm temporary WebSocket comes up, then restore FCM. Diagnostics should show a recovery probe received, a pending ACK, PC confirmation of that exact probe, and automatic WebSocket shutdown.

## Do Not Disturb / battery behavior

The `alerts2` notification channel is deliberately silent; alarm audio is played through `MediaPlayer` on the alarm stream. The app requests notification-policy access so alarms can work under DND.

Use **Disable battery optimization** once after installation. OEM background-process policies can still terminate the foreground service, and there is deliberately no boot receiver.
