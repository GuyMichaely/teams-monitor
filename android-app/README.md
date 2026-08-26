# Teams Monitor — Android companion app

Personal-use, sideloaded Android app for the Teams monitoring system in this repo.

## What it does

The native main screen shows WebSocket connection status, server URL, the last alert, quick alert toggles, and buttons for the web dashboard, Settings, battery-optimization exemption, and alarm testing.

The foreground `AlertService` maintains a WebSocket connection to the configured HTTPS server. For the normal Cloudflare setup, configure:

```text
Server URL: https://gui.guymichaely.com
Access token: same value as GUI_TOKEN on the laptop
```

The app converts that to the WSS alert endpoint and supplies the token as the WebSocket access token. Plain HTTP is intentionally unsupported.

Alerts can show a notification and/or play the alarm stream. Do Not Disturb bypass requires notification-policy access. There is deliberately no boot receiver; after reboot, open the app once.

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

The repository workflow `.github/workflows/android-apk.yml` builds the app on Android changes. Once signing is configured, it publishes a signed APK to a stable GitHub Release tagged `android-latest` and also stores the APK as a workflow artifact.

One-time signing setup from the Windows development machine:

```powershell
.\scripts\setup-android-signing.ps1
```

The script:

1. Creates or reuses a persistent Android signing key under `%USERPROFILE%\.teams-monitor`.
2. Stores the keystore and password as GitHub Actions secrets.
3. Triggers the APK workflow.

It requires the GitHub CLI (`gh`) to be authenticated and a JDK 17 `keytool` either on PATH or in the local `tools\jdk17` toolchain.

**Keep the `%USERPROFILE%\.teams-monitor` signing-key backup.** Android updates must be signed by the same key as the installed app.

After setup, Android-related pushes automatically refresh the `android-latest` Release. Download `teams-monitor.apk` from that Release on the phone and install it over the existing copy.

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
