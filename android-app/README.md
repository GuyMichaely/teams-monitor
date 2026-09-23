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

When FCM is degraded or in fallback, the PC periodically sends a silent recovery control message. One successful send against the current registration generation restores FCM primary and releases temporary WebSocket. If an older FID's in-flight result arrives after a new FID has been stored, that result is ignored.

### WebSocket fallback

The foreground `AlertService` maintains `/ws/alerts` whenever WebSocket is the preferred transport or recovery state asks for it. With FCM primary, WebSocket can remain off normally and start temporarily when FCM is degraded.

The existing WebSocket behavior remains:

- OkHttp ping every 30 seconds;
- exponential reconnect delay capped at 60 seconds;
- `START_STICKY` foreground service;
- no boot receiver.

Android background-start restrictions can prevent an immediate foreground-service start in some circumstances; recovery state remains persisted and is retried through later control/app activity rather than breaking FCM registration recovery.

### Duplicate protection

Every server alert has an `alertId`. The app retains recent IDs and suppresses duplicate alarm/notification delivery across FCM and WebSocket. Transport-control metadata is applied before duplicate suppression, so a successful FCM recovery copy can tell Android to stop temporary WebSocket without ringing twice.

## Control synchronization and optional Worker

The phone periodically reconciles control state with WorkManager, approximately every 15 minutes:

1. try the direct PC `/api/control/sync` endpoint;
2. if unavailable and the optional Worker is configured, use the Worker;
3. when direct communication succeeds, also mirror current phone state to the Worker so its independent copy stays current.

This is a safety/recovery channel, not the normal alert-delivery path.

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

The app keeps a rolling diagnostic log in app-private storage. It records service lifecycle, WebSocket connection/reconnect/failure details, FID registration/synchronization, recovery/control activity, received alert metadata, heartbeat/tunnel incidents, and notification/alarm delivery or suppression decisions. Access tokens are never intentionally logged, and URL-style `access_token` values are redacted before persistence.

The main screen's diagnostics controls filter the export by time range, event category, and optional text search. **Copy** puts the filtered report on the clipboard; the adjacent **Share file** button opens Android's Sharesheet with a `.txt` attachment. Both include the selected filters and app/device version, current network state, battery-optimization status, notification permission/state, DND access, and relevant alert settings. Filtering exports does not erase the stored log.

Reports can contain chat/author names and device information; review them before sharing. The share target receives temporary read access only to the exported file, not to the app's other files.

The default is **Last hour / All events**. Other ranges are last 24 hours, last 7 days, and all retained events. Categories include alerts/notifications, connections/registration, and errors/failures. Search is case-insensitive across each event line (including chat, author, and alert ID). Both exports keep up to 200,000 characters of newest matching whole entries, with matched/exported/omitted counts in the header. Time-limited exports exclude malformed timestamps; all-retained exports can include them. Exports show current device status, not historical status. Share files are kept in a private cache, limited to 20 reports and cleaned of files older than 24 hours on the next share.

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

## GitHub build and download

Open the [latest APK download](https://github.com/GuyMichaely/teams-monitor/releases/download/android-latest/teams-monitor.apk) on the phone and install it, then open **Teams Monitor**. Configure the server URL and access token shown above; saving connection settings synchronizes the phone with the PC.

The **Android APK** workflow (`.github/workflows/android-apk.yml`) runs when Android code or the workflow changes on `main`, and supports manual runs from GitHub Actions. It publishes `teams-monitor.apk` to the stable `android-latest` release and also uploads a workflow artifact. Versions use code `100000 + GITHUB_RUN_NUMBER` and name `1.0.<run number>`.

Repository Actions secrets:

- `ANDROID_DEBUG_KEYSTORE_BASE64`: base64 of the existing local debug signing key. Publishing is skipped without it; do not substitute a new key for an existing installation.
- `FIREBASE_GOOGLE_SERVICES_JSON_BASE64`: base64 of `app/google-services.json`. Without it, the APK builds but cannot initialize Firebase/FCM.

The PC service-account private key is not needed in the APK or this workflow. The public GUI URL [gui.guymichaely.com/app-debug.apk](https://gui.guymichaely.com/app-debug.apk) redirects to the latest GitHub release APK, independently of local builds.

## Local build and install

Requirements are JDK 17, Android SDK 34, and Gradle 8.9 (the wrapper is checked in).

```powershell
cd android-app
.\gradlew.bat assembleDebug
```

Debug output:

```text
app\build\outputs\apk\debug\app-debug.apk
```

The GUI's `/app-debug.apk` URL always downloads the GitHub release, not this local output. Use USB installation below to test a local build.

To install over USB with Android platform-tools and USB debugging enabled, run from `android-app`:

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

To install the published GitHub build instead, start the GUI and tunnel, open `https://gui.guymichaely.com/app-debug.apk` on the phone, and install the downloaded APK.

**Back up `%USERPROFILE%\.android\debug.keystore`.** Updates must use the same signing key as the installed app. Keep `app/google-services.json` present before building to include Firebase configuration.

When updating an existing installation, use a version code at least as high as the installed app's code (shown in **Copy diagnostics**). The default build uses code `1`; override it with the `appVersionCode` Gradle property, and optionally set `appVersionName`. For example, if the installed code is `100123`:

```powershell
.\gradlew.bat assembleDebug -PappVersionCode=100124 -PappVersionName=1.0.local
```

## Testing

Run Android filter unit tests and compile the APK from `android-app`:

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug
```

On a phone, check time/category/search combinations, a no-results export, clipboard contents, and sharing the text attachment to a receiving app. Confirm both export buttons use the same filters. The APK publishing workflow runs the unit tests before publishing.

For WebSocket testing, run the GUI and tunnel, set the app's server URL to `https://gui.guymichaely.com`, and use the same access token as `GUI_TOKEN`.

Saving connection settings immediately runs a control synchronization and applies the current WebSocket policy. The dashboard WebView uses the same server URL.

FCM testing requires both Firebase configuration files:

- `android-app/app/google-services.json` — Android Firebase project configuration;
- `config/fcm-service-account.json` — PC credential used to call the FCM HTTP v1 API.

Both are intentionally untracked. Place `google-services.json` in `android-app/app/` before building locally. Without that file, the APK still builds and the WebSocket path remains available, but Firebase initialization is unavailable in that APK.

For a recovery test, force FCM into degraded/fallback state, confirm temporary WebSocket comes up, then restore FCM. One successful current-generation FCM recovery send should return the PC state to `primary_working`, and the recovery control/metadata tells Android to stop temporary WS if it receives that message.

## Do Not Disturb / battery behavior

The `alerts2` notification channel is deliberately silent; alarm audio is played through `MediaPlayer` on the alarm stream. The app requests notification-policy access so alarms can work under DND.

Use **Disable battery optimization** once after installation. OEM background-process policies can still terminate the foreground service, and there is deliberately no boot receiver.
