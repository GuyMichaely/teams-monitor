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

The repository workflow `.github/workflows/android-apk.yml` runs the same `assembleDebug` build used locally. GitHub Actions restores the development PC's existing `%USERPROFILE%\.android\debug.keystore` first, so CI APKs have the same signature as local debug builds and can update the currently installed app.

One-time setup from the Windows development machine:

```powershell
.\scripts\setup-android-signing.ps1
```

The script uploads `%USERPROFILE%\.android\debug.keystore` as the `ANDROID_DEBUG_KEYSTORE_BASE64` GitHub Actions secret and triggers the APK workflow. If the debug keystore does not exist yet, run a local debug build once first:

```powershell
cd android-app
.\gradlew.bat assembleDebug
cd ..
.\scripts\setup-android-signing.ps1
```

It requires the GitHub CLI (`gh`) to be installed and authenticated.

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
