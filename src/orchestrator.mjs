// The orchestrator: poll Teams -> decide -> act -> log. Loops forever until stopped.
//
// NO loop-prevention by design: if you message yourself in a whitelisted chat with
// echoLoop on, Claude will keep replying to its own replies. That's intentional —
// use it to prove the kill switches work.
//
// KILL SWITCHES:
//   - `node src/cli.mjs stop` or the GUI Stop button: BREAK GLASS — hard-kills the
//     orchestrator process immediately via the pid in data/heartbeat.json.
//   - Ctrl+C in this terminal (SIGINT), or SIGTERM: graceful halt.
//   - data/STOP file: graceful fallback (checked every tick); `stop` drops one too
//     in case the target loop hasn't written its first heartbeat yet.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUnreadChats, readChat } from "./monitor.mjs";
import { sendMessage } from "./teams.mjs";
import { createBrain } from "./brain.mjs";
import { escalate, runActions } from "./actions.mjs";
import { startDispatcher } from "./integrations/tfs-server.mjs";
import { loadConfig, loadUserProfile } from "./context.mjs";
import { loadState, saveState, markFirstRead, logActivity, DATA_DIR } from "./state.mjs";

const STOP_FILE = join(DATA_DIR, "STOP");
const HEARTBEAT_FILE = join(DATA_DIR, "heartbeat.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chats that failed to open this run — skipped on later ticks to avoid log spam.
const unopenable = new Set();

export function requestStop() {
  writeFileSync(STOP_FILE, `stop requested ${new Date().toISOString()}\n`);
}

/**
 * Break-glass stop: kill the orchestrator process immediately, via the pid in its
 * heartbeat file. Also drops the STOP file as a fallback (a just-started loop that
 * hasn't written its first heartbeat yet will still halt on its first tick).
 * Refuses to kill when the heartbeat is stale, so a dead orchestrator's pid —
 * possibly since reused by an unrelated process — is never signaled.
 */
export function hardStop({ maxHeartbeatAgeMs = 120_000 } = {}) {
  requestStop();
  let hb = null;
  try {
    hb = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8"));
  } catch {
    return { killed: false, reason: "no heartbeat file (orchestrator not running?)" };
  }
  const pid = hb?.pid;
  if (!pid) return { killed: false, reason: "heartbeat has no pid" };
  const ageMs = Date.now() - Date.parse(hb.at || 0);
  if (!(ageMs >= 0 && ageMs < maxHeartbeatAgeMs)) {
    rmSync(HEARTBEAT_FILE, { force: true });
    return { killed: false, pid, reason: `stale heartbeat (${Math.round(ageMs / 1000)}s old) — not killing` };
  }
  try {
    // Windows ignores the signal and force-terminates; SIGKILL is uncatchable on POSIX.
    process.kill(pid, "SIGKILL");
    rmSync(HEARTBEAT_FILE, { force: true });
    rmSync(STOP_FILE, { force: true }); // process is dead — the fallback isn't needed
    return { killed: true, pid };
  } catch (e) {
    if (e.code === "ESRCH") {
      rmSync(HEARTBEAT_FILE, { force: true });
      return { killed: false, pid, reason: "process not found (stale pid)" };
    }
    throw e;
  }
}

export async function run() {
  let config = await loadConfig();
  let userProfile = await loadUserProfile();
  const brain = createBrain(config);

  // Start the TFS dispatcher (job queue + worker-facing HTTP) and register TFS actions,
  // if configured. The VM worker connects out to this.
  let dispatcher = null;
  if (config?.integrations?.tfs?.enabled) {
    try {
      dispatcher = startDispatcher(config);
    } catch (e) {
      console.error("   TFS dispatcher not started: " + e.message);
    }
  }

  // Clear any stale stop request from a previous run.
  if (existsSync(STOP_FILE)) rmSync(STOP_FILE);

  let running = true;
  const stop = (why) => {
    if (!running) return;
    running = false;
    console.error(`\n⏹  Stopping (${why}).`);
  };
  process.on("SIGINT", () => stop("Ctrl+C"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  console.error(
    `▶  Orchestrator started. provider=${config.brain?.provider} ` +
      `poll=${config.pollIntervalMs}ms whitelist=[${(config.whitelist?.autoSend || []).join(", ")}] ` +
      `echoLoop=${!!config?.debug?.echoLoop}. Ctrl+C or \`cli.mjs stop\` to halt.`
  );

  while (running) {
    if (existsSync(STOP_FILE)) {
      stop("stop file");
      rmSync(STOP_FILE);
      break;
    }
    // Re-read config each tick so GUI edits (whitelist etc.) apply live.
    try { config = await loadConfig(); } catch { /* keep last good config */ }
    // Same for the brain's user context (editable from the GUI's profile section).
    try { userProfile = await loadUserProfile(); } catch { /* keep last good profile */ }
    const whitelist = new Set(config.whitelist?.autoSend || []);
    const echoLoop = !!config?.debug?.echoLoop;
    // Heartbeat for the GUI: proves the loop is actually ticking. Guarded — a
    // transient file-lock blip (AV scan etc.) must not kill the loop.
    try {
      writeFileSync(
        HEARTBEAT_FILE,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), provider: config.brain?.provider }) + "\n"
      );
    } catch { /* try again next tick */ }
    try {
      await tick({ config, brain, userProfile, whitelist, echoLoop });
    } catch (e) {
      console.error("tick error:", e.message);
    }
    // Interruptible wait.
    for (let waited = 0; running && waited < config.pollIntervalMs; waited += 250) {
      if (existsSync(STOP_FILE)) break;
      await sleep(250);
    }
  }
  if (dispatcher) await dispatcher.close().catch(() => {});
  rmSync(HEARTBEAT_FILE, { force: true });
  console.error("✔  Orchestrator halted.");
}

async function tick({ config, brain, userProfile, whitelist, echoLoop }) {
  // In echoLoop mode we don't rely on unread state — we re-examine whitelisted
  // chats every tick so a self-reply keeps the loop going.
  const targets = echoLoop
    ? [...whitelist]
    : await getUnreadChats(config.port);

  if (!targets.length) return;

  const state = await loadState();

  for (const chat of targets) {
    // Skip chats we've already found unopenable this run, so one bad chat (e.g. an
    // untitled meeting chat that isn't reachable) doesn't spam every tick.
    if (unopenable.has(chat)) continue;
    try {
      await processChat({ chat, config, brain, userProfile, whitelist, state, echoLoop });
    } catch (e) {
      console.error(`[${chat}] skipped: ${e.message}`);
      if (/not found in rail/.test(e.message)) unopenable.add(chat);
    }
  }

  await saveState(state);
}

/** Word-boundary, case-insensitive match of any configured name against text. */
export function isAddressed(text, mentionNames) {
  return (mentionNames || []).some(
    (n) =>
      n &&
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text || "")
  );
}

async function processChat({ chat, config, brain, userProfile, whitelist, state, echoLoop }) {
  const { messages } = await readChat(chat, 15, config.port);
  if (!messages?.length) return;
  const latest = messages[messages.length - 1];

  // Capture before markFirstRead overwrites it — the dedupe below needs the
  // PREVIOUS lastSeen.
  const prevSeen = state.chats?.[chat]?.lastSeen;
  await markFirstRead(state, chat, latest);

  // Dedupe: some chats never clear Teams' unread flag when the monitor opens
  // them (the self-chat, some group chats), so the same "latest" would be
  // re-processed — and re-sent to the LLM — every tick. Skip anything we've
  // already handled. echoLoop mode is exempt: re-processing is its point.
  if (
    !echoLoop &&
    prevSeen &&
    prevSeen.time === latest.time &&
    prevSeen.author === latest.author &&
    prevSeen.text === latest.text
  ) {
    return;
  }

  // Alert-everything mode (config.alerts.notifyAll): no brain in the loop —
  // every incoming message pushes a phone alert via the alert_phone tool and
  // nothing else is decided or sent.
  if (config.alerts?.notifyAll) {
    if ((config.alerts?.ignoreAuthors || []).includes(latest.author)) {
      await logActivity({ kind: "alert", chat, latest, skipped: `author ignored: ${latest.author}` });
      return;
    }
    const results = await runActions(
      [{ name: "alert_phone", args: { chat, author: latest.author, text: latest.text, time: latest.time } }],
      { chat, latest }
    );
    await logActivity({ kind: "alert", chat, latest, results });
    console.error(`[${chat}] alert — ${results[0]?.error || "sent"}`);
    return;
  }

  const whitelisted = whitelist.has(chat);
  const decision = await brain.decide({
    chat,
    latest,
    history: messages,
    userProfile,
    whitelisted,
    config,
  });

  await logActivity({
    kind: "decision",
    chat,
    whitelisted,
    latest,
    action: decision.action,
    reason: decision.reason,
    reply: decision.reply || null,
  });
  console.error(`[${chat}] ${decision.action} — ${decision.reason}`);

  // Carry out the decision. readChat() above already navigated to `chat`, so the
  // compose box targets it — no re-open needed.
  if (decision.action === "respond" && whitelisted && decision.reply) {
    const result = await sendMessage(decision.reply, config.port);
    await logActivity({ kind: "send", chat, text: decision.reply, result });
    console.error(`   ↳ sent: ${decision.reply}  (${result})`);
  } else if (decision.action === "respond" && !whitelisted) {
    // Not allowed to auto-send here: fall back to hold + escalate.
    await holdAndEscalate(config, chat, latest, "respond requested in non-whitelisted chat");
  } else if (decision.action === "hold") {
    await holdAndEscalate(config, chat, latest, decision.reason);
  } else if (decision.action === "escalate") {
    await escalate({ chat, latest, reason: decision.reason });
  }

  // Brain-requested actions. Only actions registered in actions.mjs run.
  if (decision.invokeActions?.length) {
    const results = await runActions(decision.invokeActions, { chat, latest });
    await logActivity({ kind: "actions", chat, results });
  }

  // Addressed backstop: the brain is prompted to invoke alert_phone when the
  // user is addressed, but a name ping shouldn't depend on model consistency —
  // if a configured name matches and the brain didn't alert, fire it anyway.
  const mentionNames = config.alerts?.mentionNames || [];
  if (mentionNames.length && !(config.alerts?.ignoreAuthors || []).includes(latest.author)) {
    const addressed = isAddressed(latest.text, mentionNames);
    const alreadyAlerted = (decision.invokeActions || []).some((a) => a.name === "alert_phone");
    if (addressed && !alreadyAlerted) {
      const results = await runActions(
        [{ name: "alert_phone", args: { chat, author: latest.author, text: latest.text, time: latest.time } }],
        { chat, latest }
      );
      await logActivity({ kind: "alert", chat, latest, reason: "addressed backstop (name match)", results });
      console.error(`[${chat}] alert — addressed backstop (${results[0]?.error || "sent"})`);
    }
  }
}

async function holdAndEscalate(config, chat, latest, reason) {
  if (config.holdMessage) {
    // A non-committal holding reply only goes out where auto-send is allowed.
    if ((config.whitelist?.autoSend || []).includes(chat)) {
      await sendMessage(config.holdMessage, config.port);
      await logActivity({ kind: "send", chat, text: config.holdMessage, hold: true });
    }
  }
  await escalate({ chat, latest, reason });
}
