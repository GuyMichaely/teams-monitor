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
import { randomUUID } from "node:crypto";
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

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isSelfAuthored(author, mentionNames) {
  const normalized = normalizeIdentity(author);
  return normalized === "you" || (mentionNames || []).some((name) => normalizeIdentity(name) === normalized);
}

function looksLikeDirectChat(chat, author) {
  const chatName = normalizeIdentity(chat);
  const authorName = normalizeIdentity(author);
  return !!chatName && chatName === authorName;
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

  const flowId = randomUUID();
  let effectCount = 0;
  const flow = async (stage, fields = {}) => {
    await logActivity({ kind: "flow", flowId, stage, chat, ...fields });
  };
  const recordEffect = async (effect, status, fields = {}) => {
    effectCount++;
    await flow("effect", { effect, status, ...fields });
  };
  const actionStatus = (results) =>
    (results || []).some((r) => r?.error) ? "error" : "ok";

  await flow("message", { latest, historyCount: messages.length });

  // Alert-everything mode bypasses the brain, but still emits a complete flow so
  // the GUI makes that bypass explicit rather than leaving mysterious gaps.
  if (config.alerts?.notifyAll) {
    await flow("brain_input", { skipped: true, reason: "alerts.notifyAll bypasses the brain" });
    if ((config.alerts?.ignoreAuthors || []).includes(latest.author)) {
      const reason = `author ignored: ${latest.author}`;
      await flow("decision", { action: "ignore", reason });
      await logActivity({ kind: "alert", flowId, chat, latest, skipped: reason });
      await recordEffect("ignored", "ignored", { reason });
      return;
    }
    const reason = "alerts.notifyAll enabled; brain bypassed";
    await flow("decision", { action: "alarm", reason });
    const results = await runActions(
      [{ name: "alert_phone", args: { chat, author: latest.author, text: latest.text, time: latest.time } }],
      { chat, latest }
    );
    await logActivity({ kind: "alert", flowId, chat, latest, results });
    await recordEffect("phone_alert", actionStatus(results), { reason, results });
    console.error(`[${chat}] alert — ${results[0]?.error || "sent"}`);
    return;
  }

  const whitelisted = whitelist.has(chat);
  let decision;
  try {
    decision = await brain.decide(
      {
        chat,
        latest,
        history: messages,
        userProfile,
        whitelisted,
        config,
      },
      {
        onInput: (payload) => flow("brain_input", payload),
        onOutput: (payload) => flow("brain_output", payload),
        onDecision: ({ decision: d }) => flow("decision", {
          action: d.action,
          reason: d.reason,
          reply: d.reply || null,
          invokeActions: d.invokeActions || [],
        }),
      }
    );
  } catch (e) {
    await flow("error", { source: "brain", error: e.message });
    throw e;
  }

  // Keep the pre-existing decision record for compatibility with counters and
  // older tooling. flowId links it to the richer pipeline trace.
  await logActivity({
    kind: "decision",
    flowId,
    chat,
    whitelisted,
    latest,
    action: decision.action,
    reason: decision.reason,
    reply: decision.reply || null,
  });
  console.error(`[${chat}] ${decision.action} — ${decision.reason}`);

  // Alert-only mode: the brain classifies alarm vs ignore, and the orchestrator
  // performs the phone alert deterministically. Whitelists and reply text cannot
  // cause a Teams send while this mode is active.
  if (config.automation?.mode === "alert-only") {
    const mentionNames = config.alerts?.mentionNames || [];
    const ignoredAuthor =
      (config.alerts?.ignoreAuthors || []).includes(latest.author) ||
      isSelfAuthored(latest.author, mentionNames);
    const directChat = !ignoredAuthor && looksLikeDirectChat(chat, latest.author);
    const addressed = !ignoredAuthor && isAddressed(latest.text, mentionNames);
    const shouldAlarm = !ignoredAuthor && (decision.action === "alarm" || directChat || addressed);

    if (shouldAlarm) {
      const reason = decision.action === "alarm"
        ? decision.reason
        : directChat
          ? "direct chat backstop"
          : "addressed backstop (name match)";
      await escalate({ chat, latest, reason, flowId });
      await recordEffect("escalation_log", "ok", { reason });
      const results = await runActions(
        [{ name: "alert_phone", args: { chat, author: latest.author, text: latest.text, time: latest.time } }],
        { chat, latest }
      );
      await logActivity({ kind: "alert", flowId, chat, latest, reason, results });
      await recordEffect("phone_alert", actionStatus(results), { reason, results });
      console.error(`[${chat}] alarm — ${reason} (${results[0]?.error || "sent"})`);
    } else {
      const reason = ignoredAuthor ? "message authored by user/ignored author" : decision.reason;
      await recordEffect("ignored", "ignored", { reason });
      console.error(`[${chat}] no alarm — ${reason}`);
    }
    return;
  }

  // Carry out the decision. readChat() above already navigated to `chat`, so the
  // compose box targets it — no re-open needed.
  if (decision.action === "respond" && whitelisted && decision.reply) {
    try {
      const result = await sendMessage(decision.reply, config.port);
      await logActivity({ kind: "send", flowId, chat, text: decision.reply, result });
      await recordEffect("teams_reply", result === "sent" ? "ok" : "error", {
        text: decision.reply,
        result,
      });
      console.error(`   ↳ sent: ${decision.reply}  (${result})`);
    } catch (e) {
      await recordEffect("teams_reply", "error", { text: decision.reply, detail: e.message });
      throw e;
    }
  } else if (decision.action === "respond" && !whitelisted) {
    await holdAndEscalate(config, chat, latest, "respond requested in non-whitelisted chat", flowId, recordEffect);
  } else if (decision.action === "hold") {
    await holdAndEscalate(config, chat, latest, decision.reason, flowId, recordEffect);
  } else if (decision.action === "escalate") {
    await escalate({ chat, latest, reason: decision.reason, flowId });
    await recordEffect("escalation_log", "ok", { reason: decision.reason });
  }

  // Brain-requested actions. Only actions registered in actions.mjs run.
  if (decision.invokeActions?.length) {
    const results = await runActions(decision.invokeActions, { chat, latest });
    await logActivity({ kind: "actions", flowId, chat, results });
    await recordEffect("brain_actions", actionStatus(results), { results });
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
      const reason = "addressed backstop (name match)";
      await logActivity({ kind: "alert", flowId, chat, latest, reason, results });
      await recordEffect("phone_alert_backstop", actionStatus(results), { reason, results });
      console.error(`[${chat}] alert — addressed backstop (${results[0]?.error || "sent"})`);
    }
  }

  if (!effectCount) {
    await recordEffect("none", "ignored", { reason: "decision produced no side effect" });
  }
}

async function holdAndEscalate(config, chat, latest, reason, flowId, recordEffect) {
  if (config.holdMessage && (config.whitelist?.autoSend || []).includes(chat)) {
    try {
      const result = await sendMessage(config.holdMessage, config.port);
      await logActivity({ kind: "send", flowId, chat, text: config.holdMessage, hold: true, result });
      await recordEffect("hold_message", result === "sent" ? "ok" : "error", {
        text: config.holdMessage,
        result,
      });
    } catch (e) {
      await recordEffect("hold_message", "error", { text: config.holdMessage, detail: e.message });
      throw e;
    }
  }
  await escalate({ chat, latest, reason, flowId });
  await recordEffect("escalation_log", "ok", { reason });
}
