# Features TODO

Captured from the 2026-08-01 design discussion. Unscheduled — refine each item
before implementing. Ordered roughly by priority.

## 1. Response policy rework (replaces the whitelist)

Today: `whitelist.autoSend` — auto-send only in listed chats, everything else is
hold + escalate.

Desired:

- **Default posture: the system may respond to anyone.** The binary whitelist goes away.
- **Risk tiers** instead of a binary list:
  - Low-risk people/topics → auto-send freely.
  - Benign / low-value messages → OK to ignore (no reply, no alert).
  - Everything else, or whenever the brain is **not confident** → alert me rather than guess.
- **Follow-up / history awareness.** If someone was ignored and follows up, the
  system should auto-respond or escalate. Needs per-chat decision history — we
  have `data/activity.jsonl` as the audit trail; likely also want a per-chat
  "consecutive ignores" counter in `data/state.json` so follow-up detection is
  deterministic rather than re-derived from logs.
- **Open design question:** explicit rules vs. feeding the "vibe" as context to
  the brain LLM at inference time.
  - Leading idea (hybrid): deterministic gates for hard constraints (never
    auto-send to X, always-escalate patterns) — cheap and auditable; LLM with
    rich context for the gray zone (tone, risk, follow-up judgment).

## 2. Org-hierarchy awareness

- The brain should know the corporate hierarchy relevant to me — **me, my
  descendants, my siblings, and all my ancestors** — and use it when deciding
  how/whether to respond (a boss, a peer, and a report get different handling).
- **Automate collection** — don't hand-maintain. Pull the org chart from
  Teams/Graph (via the CDP session or an API), or another corporate source.
- **Refresh:** weekly. Either a time-based trigger or a manual "refresh org
  chart" button in the GUI (button first is simpler; scheduling can come later).
- Output: something like `context/org-chart.md` (or JSON) fed to the brain
  alongside `user-profile.md`.

## 3. GUI as "avatar of me"

Direction: the GUI should feel like an avatar I've instructed to monitor and
respond on my behalf — not just a log viewer.

- **Visibility into monitoring:** show what it's doing right now — current tick,
  which chats are unread/being read, the last decision per chat (not just the
  global activity feed).
- **Context supply** (design needed): a way for me to tell it what I'm doing /
  working on so its replies are accurate. Candidates:
  - A free-form "current focus" editor in the GUI → `context/current-focus.md`,
    injected into the brain prompt next to `user-profile.md`. (Simplest; good first step.)
  - Later: per-person / per-chat notes; auto-derived context (calendar, my
    assigned TFS tickets).
- **Editable monitoring instructions:** a GUI editor for standing instructions
  to the brain (tone, things to never say, when to wake me) — a user-editable
  layer of the system prompt, versioned so edits are auditable.

## 4. Android companion app

Decisions locked 2026-08-01: Kotlin + WebView shell (dashboard = the existing
web GUI at the Cloudflare-tunnel URL, native code only for push + alarm sound).
Sideloaded APK, personal use only; target a Pixel 6 / Android 16, minSdk ~26
for broad compatibility. Alert sound: custom bundled sound on an
`IMPORTANCE_HIGH` notification channel (channels are immutable after creation —
get it right in the first build).

- Server side is DONE: `alert_phone` action + `alerts.notifyAll` mode +
  `/ws/alerts` hub in the GUI server + FCM transport in `src/alerts.mjs`.
- Transport is config-selectable (`alerts.transport`): `websocket` (app
  maintains a connection to the hub) or `fcm` (recommended for alarms — the
  only mechanism that reliably wakes a dozing phone).
- App scaffold EXISTS (`android-app/`): Kotlin + WebView, foreground-service
  WebSocket with backoff reconnect, alarm notification channel with bundled
  sound, boot receiver, battery-optimization flow, URL/token settings screen.
  Written without a compiler — first build in Android Studio is the smoke test.
- Still needed: build/sideload the app (Android Studio + SDK 34), on-device
  test via `adb reverse tcp:8090 tcp:8090`, Cloudflare tunnel + Access for the
  GUI, then the Firebase project to switch transport to `fcm`.

## Known gaps (from the 2026-08-01 state report)

- ~~LLM provider call in `src/brain.mjs` is still a scaffold~~ → DONE 2026-08-02:
  `gemini` provider implemented (config: `brain.provider`, `brain.model`,
  `brain.apiKey` or env). anthropic/openai remain seams.
- ~~Escalation transport is console-only~~ → DONE 2026-08-01: `alert_phone`
  action + `alerts.notifyAll` mode (websocket hub + FCM). The companion app
  itself is still to be built (section 4).
- The loop triages the user's **own** outbound messages (Teams marks replies to
  you as unread). Suppress self-authored "latest" messages before enabling real
  auto-send.
- `context/user-profile.md` is still mostly template.
- TFS agent: never deployed on the VM, never tested against live TFS;
  `run_agent_task` unimplemented.
