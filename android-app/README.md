# Teams Monitor — Android companion app

Personal-use, sideloaded Android app for the Teams monitoring system in this repo.

## What it does

The native main screen shows WebSocket connection status, server URL, the last alert, quick alert toggles, and buttons for the web dashboard, Settings, battery-optimization exemption, alarm testing, and diagnostics export.

The foreground `AlertService` maintains a WebSocket connection to the configured HTTPS server. For the normal Cloudflare setup, configure:

```text
Server URL: https://gui.guymichaely.com
Access token: same value as GUI_TOKEN on the laptop
```

The app converts that to the WSS alert endpoint and supplies the token as the WebSocket access token. Plain HTTP is intentionally unsupported.

Alerts can show a notification and/or play the alarm stream. Do Not Disturb bypass requires notification-policy access. There is deliberately no boot receiver; after reboot, open the app once.

## Diagnostics

The app keeps a rolling diagnostic log in app-private storage. It records service lifecycle, 15-minute service heartbeats, WebSocket connection/reconnect/failure details, received alert metadata, and notification/alarm delivery or suppression decisions. Access tokens are never intentionally logged, and URL-style `access_token` values are redacted before persistence.

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

The intended remote connection path is the Cloudflare tunnel. Run the GUI and tunnel, then set the app's server URL to `https://gui.guymichaely.com` and use the same access token as the server's `GUI_TOKEN`.

Saving connection settings reconnects the alert listener immediately. The dashboard WebView uses the same server URL.

## Do Not Disturb / battery behavior

The `alerts2` notification channel is deliberately silent; alarm audio is played through `MediaPlayer` on the alarm stream. The app requests notification-policy access so alarms can work under DND.

Use **Disable battery optimization** once after installation. OEM background-process policies can still terminate the foreground service, and there is deliberately no boot receiver.

## FCM later

Alert handling is centralized in `AlertNotifier.alert(...)`; a future `FirebaseMessagingService` can call that same path. The current WebSocket connection remains the active transport.
