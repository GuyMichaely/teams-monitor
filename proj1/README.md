# teams-automation

Read and send Microsoft Teams messages programmatically by driving the **new Teams
client** (MSIX / WebView2) over the **Chrome DevTools Protocol (CDP)**.

The new Teams runs on Edge WebView2 (Chromium). When launched with a remote-debugging
port, its app window becomes a controllable CDP target — so we get real DOM access
(`querySelector`, click, type) instead of brittle screen-coordinate automation.

## Requirements

- New Teams desktop client (MSIX build; the `ms-teams.exe` process).
- Node.js 20+ (uses built-in `fetch` and `WebSocket` — **no npm dependencies**).

## Setup

You normally don't need to do anything: if Teams isn't running with the debug port,
the CLI restarts it automatically — kills any existing instance, then launches via
the app execution alias with the debug flag scoped to that process. To launch it
manually instead, two options:

### Option A — per-launch (recommended, safer)

Fully quit Teams (tray icon → **Quit**), then:

```powershell
./scripts/launch-teams.ps1        # opens port 9222
```

This scopes the debug flag to just that Teams process.

### Option B — persistent (every launch, all WebView2 apps)

```powershell
setx WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS "--remote-debugging-port=9222"
```

Then fully quit and reopen Teams. **Security note:** this applies to *every* WebView2
app you launch, and an open debug port lets any local process drive them. Prefer
Option A unless you specifically want it always on.

### Verify the port is live

```powershell
Invoke-RestMethod http://localhost:9222/json/version
```

## Usage

Low-level (operate on whatever chat is open, or by name):

```bash
node src/cli.mjs chats                 # list all chats/channels
node src/cli.mjs unread                # list chats with unread messages
node src/cli.mjs readchat "Andrew Coe" # open a chat by name and read it (marks read)
node src/cli.mjs read 10               # last 10 messages of the open chat, as JSON
node src/cli.mjs send "hello"          # send into the open chat
node src/cli.mjs watch 3000            # print new messages as they arrive
```

The orchestrator (monitor → decide → respond/hold/escalate):

```bash
node src/cli.mjs run       # start the loop (Ctrl+C to stop)
node src/cli.mjs stop      # kill a running loop immediately (break glass)
node src/cli.mjs catchup   # per-chat "resume reading here" markers
```

Configure it in `config/config.json` (copy from `config.example.json`).

## Architecture

```
teams.mjs      CDP core: listChats / setUnreadFilter / openChat / readOpenChat / sendMessage
monitor.mjs    enumerate chats, find unread (Teams' own filter), open+read a chat
brain.mjs      decide respond | hold | escalate (+ draft). Providers: stub | gemini | anthropic/openai (seams)
actions.mjs    escalation + the brain's action registry (its "tools"), incl. alert_phone
alerts.mjs     phone-alert transports: websocket (via GUI hub) | fcm (Firebase direct)
context.mjs    config loading + user-profile.md (the context fed to the brain)
state.mjs      audit: per-chat first-read markers + data/activity.jsonl
orchestrator.mjs   the loop tying it together; kill switches: Ctrl+C / SIGTERM / `stop` (hard kill)
```

Config knobs: `whitelist.autoSend` (chats Claude may auto-reply in), `holdMessage`,
`brain.provider`, `alerts.*` (phone alerts), `debug.echoLoop`.

### Phone alerts (the `alert_phone` tool)

The brain (or the loop itself) can push alerts to your phone via the
`alert_phone` action. Transport is selected by `alerts.transport`:

- **`websocket`** (default) — the orchestrator POSTs to the GUI server's
  `POST /api/alerts`, which broadcasts to companion apps subscribed on
  `ws://<gui>/ws/alerts`. Works with any WebSocket client today; the Android
  companion app will just be one of those. Requires the GUI server to be running.
- **`fcm`** — Firebase Cloud Messaging (HTTP v1) direct from the orchestrator.
  Data-only message, Android HIGH priority, so the app's own receiver controls
  the alarm. Needs `alerts.fcm.projectId`, the app's `deviceToken`, and a
  service-account JSON at `alerts.fcm.serviceAccountFile` (gitignored).

With **`alerts.notifyAll: true`** there is no brain in the loop at all: every
incoming message pushes an alert and nothing is decided or sent. Authors in
`alerts.ignoreAuthors` (e.g. yourself) never alert.

### Cross-app actions (TFS)

TFS work runs on a **separate VM**. `tfs-agent/` is that remote service (holds the PAT);
the laptop talks to it over **TFS Agent Protocol v1** (`tfs-agent/PROTOCOL.md`). The
laptop end (`src/integrations/tfs-server.mjs`) registers each TFS primitive as an
action the brain can call. See `tfs-agent/README.md`.

## Monitor + auto-respond (the orchestrator)

Beyond the low-level read/send, there's a monitor loop that scans your chats,
decides what to do about new messages, and either replies, holds, or escalates.

```bash
node src/cli.mjs run        # start the loop
node src/cli.mjs stop       # kill it immediately (from any terminal)
node src/cli.mjs catchup    # per-chat: where to resume reading yourself
```

Configure it in `config/config.json` (copy from `config/config.example.json`):

- **`whitelist.autoSend`** — chats where Claude may actually send replies. Everything
  else defaults to **hold + escalate**. Starts as just your self-chat.
- **`brain.provider`** — `stub` (rule-based, no API key) drives the whole pipeline
  today. `anthropic`/`openai` are seams in `src/brain.mjs` to fill in later.
- **`context/user-profile.md`** — your projects/tone/people, fed to the brain as its
  context about you. This is the channel for "what the AI should know about me".

### Stopping (kill switches)

The loop has **no self-reply prevention by design** — so any of these halts it:

- **`node src/cli.mjs stop`** or the GUI **Stop** button — **break glass**: kills the
  orchestrator process immediately, via the pid in `data/heartbeat.json`. (Refuses
  to kill on a stale heartbeat, so a recycled pid is never signaled. Also drops a
  `data/STOP` file as a fallback for a loop that hasn't heartbeated yet.)
- **Ctrl+C** in the run terminal (SIGINT), or SIGTERM — graceful halt.

### Safe test with your self-chat

1. Set `debug.echoLoop: true` and keep `whitelist.autoSend: ["Guy Michaely (You)"]`.
2. `node src/cli.mjs run`
3. From another Teams client, send yourself a message. Claude replies, then (echoLoop)
   keeps replying to its own replies — an intentional infinite loop.
4. Halt with Ctrl+C or `node src/cli.mjs stop`.

With `echoLoop: false`, the loop instead scans **unread** chats each tick; opening a
chat to read it marks it read (tracked in `catchup` so you can review from there).
While the monitor runs, Teams' **Unread filter is left switched on** — Teams isn't
meant to be used for anything else during a monitor session, and the filter is not
restored on exit.

## How it works

- `src/teams.mjs` — core CDP library: connect to the chat window, read/send, plus
  rail helpers (`listChats`, `setUnreadFilter`, `openChat`). Restarts Teams with the
  debug port automatically if it isn't reachable.
- `src/monitor.mjs` — enumerate chats, find unread (via Teams' own "Unread" filter,
  which stays on for the whole monitor session), read a specific chat.
- `src/brain.mjs` — decide `respond | hold | escalate` (+ optional actions). Message
  text is treated as untrusted (prompt-injection-safe prompt assembly).
- `src/actions.mjs` — escalation (console) + the brain's action registry
  (`alert_phone` is registered here; transports live in `src/alerts.mjs`).
- `src/orchestrator.mjs` — the loop: poll → decide → act → log.
- `src/state.mjs` — per-chat catch-up markers + `data/activity.jsonl` audit log.
- Stable selectors (this Teams build): compose `[data-tid="ckeditor"]`,
  send `[data-tid="sendMessageCommands-send"]`, messages `[data-tid="chat-pane-message"]`,
  author `[data-tid="message-author-name"]`; rail rows are `role="treeitem"` leaves
  with a `<time>` (last-message timestamp).

## Known limitations / TODO

- **Targets the currently-open chat only.** No chat navigation yet — see roadmap below.
- **Selectors can break on Teams updates.** They're `data-tid`-based (more stable than
  visible text), but a major client update may require re-inspection. Re-run a DOM scan
  if reads/sends stop matching.
- **Send requires a focused, ready compose box.** Returns `send-disabled` if Teams
  hasn't enabled the send button yet.
- Roadmap: select a chat by name from the left rail; open a chat by deep link;
  read a specific chat without changing what's on screen; message de-dup by stable id.
