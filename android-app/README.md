# Teams Monitor — Android companion app

Personal-use, sideloaded Android app for the Teams-monitoring system in this repo.
Not for Play Store.

- **Main screen (native)**: three large quick toggles (**Alarm sound**,
  **Notifications**, **Alarm when screen is on** — green ON / grey OFF, they
  flip the same settings as the Settings screen and take effect immediately),
  connection status (WebSocket state, server URL, last alert received), plus
  buttons: **Open dashboard**, **Settings**, **Disable battery optimization**,
  and **Test alarm** (plays the alarm with the current settings so you can
  tune it; press again — now labeled **Stop alarm** — to cut it short).
- **Dashboard**: full-screen WebView wrapping the web dashboard, reached via
  the Cloudflare tunnel (`https://gui.<domain>`). Server URL is set in the
  app's Settings screen. Plain HTTP is intentionally unsupported (cleartext
  traffic is disabled) — https only.
- **Alerts**: foreground service holds a WebSocket to
  `ws(s)://<host>:8090/ws/alerts` and, for each alert, posts a HIGH-importance
  (silent) notification and plays an alarm sound via MediaPlayer on the alarm
  stream (system alarm ringtone by default, or the bundled alarm.wav — see
  Settings). Behavior is configurable in Settings (see below). If an access token is configured it is appended as `?access_token=<token>` to the
  WebSocket URL. The dashboard's own login overlay handles token entry for the
  WebView — the app does not inject HTTP headers.

## Settings

Two sections:

- **Connection**: server URL (`https://gui.<domain>`) and optional access
  token. Saving reconnects the alert listener immediately.
- **Alerts**:
  - *Play alarm sound* (default on) — master switch for the alarm.
  - *Show notification* (default on) — master switch for the notification.
  - *Alarm even when screen is on* (default off) — when off, the alarm sound
    is suppressed while the screen is on/interactive (the notification still
    posts); when on, it always sounds.
  - *Use system alarm ringtone* (default on) — the phone's built-in alarm
    ringtone; turn off to use the bundled alarm.wav instead.
  - *Alarm volume* (0–100, default 100) — scales within the alarm stream.
  - *Alarm duration* (seconds, default 8) — how long the loop plays.

The main screen's **Test alarm** button is a toggle: it plays the alarm with
these settings (ignoring the screen-on rule — it's an explicit test) and
stops it on a second press.

A playing alarm stops when: its duration elapses, you press **Stop alarm**,
you press a **physical volume button** (any stream volume change while
playing counts as dismiss), you turn the screen **on** (unconditional — even
with *Alarm even when screen is on* enabled), you move the volume slider in
Settings, or the main screen comes to the foreground.

## Prerequisites

Two ways to get a toolchain:

- **In-repo toolchain (already set up on the dev machine)**: the repo's
  gitignored `tools/` dir holds a portable JDK 17 (`tools/jdk17`), the Android
  SDK with platform 34 + build-tools + adb (`tools/android-sdk`), and Gradle
  8.9 (`tools/gradle`). From Git Bash:
  ```bash
  export JAVA_HOME="$PWD/tools/jdk17"
  export ANDROID_HOME="$PWD/tools/android-sdk"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  ```
- **Android Studio** (Koala or newer), with **Android SDK 34** installed
  (SDK Manager → Android 14). JDK 17 is bundled with Android Studio.

Either way: the laptop's GUI server must be running (`node src/cli.mjs gui`)
for the app to connect.

## First open in Android Studio

1. Open the `android-app/` directory (not the repo root).
2. Trust the project when prompted.
3. If asked, install Android SDK 34 via the SDK Manager prompt.
4. If `gradlew` hasn't been generated yet (no checked-in wrapper jar), let
   Android Studio sync once — it generates it from
   `gradle/wrapper/gradle-wrapper.properties` (Gradle 8.9). CLI alternative:
   `gradle wrapper` once with a local Gradle.

## Build & install

- From Android Studio: **Build → Build APK(s)** →
  `app/build/outputs/apk/debug/app-debug.apk`.
- From CLI (with the in-repo toolchain):
  ```bash
  cd android-app
  ./gradlew assembleDebug
  ```

The laptop's GUI server serves the latest build straight from the Gradle
output dir, so installing is: on the phone (same Wi-Fi), open
`http://<laptop-LAN-IP>:8090/app-debug.apk` in the browser, download, and
allow install from unknown sources when prompted.

## Testing (tunnel only)

There is no localhost/`adb reverse` test path — cleartext HTTP is disabled.
Run the Cloudflare tunnel, then in the app set the server URL to
`https://gui.<domain>` (and the access token if the server requires one).

The first launch opens Settings automatically; afterwards use the **Settings**
button on the main screen (or the overflow menu). Saving connection settings
restarts the alert listener; the dashboard picks up the new URL next time it
opens.

## Do Not Disturb

The `alerts2` channel is created with `setBypassDnd(true)`, but that only
takes effect after the user grants the app notification-policy access. The app
asks for this on first run (the system DND-access settings screen opens once),
and until access is granted a red banner sits at the top of the main screen
warning that alarms may be silenced — its **Allow** button reopens the
settings screen.

## Regenerating the alarm sound

`node tools/gen-alarm.mjs` rewrites `app/src/main/res/raw/alarm.wav`
(22050 Hz 16-bit mono, three ascending beeps repeated 3x, ~2.1s).
Only used when *Use system alarm ringtone* is off. The sound is played by the
app via MediaPlayer (alarm stream), not bound to
the notification channel, so a new build with a new WAV just works — no
channel-reset gymnastics.

## Battery optimization (known weak point)

WebSocket connections doze with the phone. The **Disable battery
optimization** button (also in the overflow menu) fires
`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; accept the prompt. Do this once
after installing. Even then, OEM task killers (Xiaomi, Samsung, etc.) may
still reap the service, and there is deliberately **no boot receiver** — after
a reboot, open the app once to restart the listener.

## FCM later

Alert handling is centralized in `AlertNotifier.alert(...)`; a future
`FirebaseMessagingService` should parse its data payload and call that instead
of duplicating notification code. The WebSocket path (`AlertService`) then
becomes the fallback for when FCM is unavailable. No Firebase dependencies are
in the build yet.
