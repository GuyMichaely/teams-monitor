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
import { reactionMessages } from "./reaction-messages.mjs";
import { join } from "node:path";
import { getUnreadChats, readChat } from "./monitor.mjs";
import { sendMessage } from "./teams.mjs";
import { createBrain } from "./brain.mjs";
import { runActions } from "./actions.mjs";
import { decideWithRules } from "./rule-policy.mjs";
import { isReplyAllowed, replyPolicy } from "./reply-policy.mjs";
import { createPoll } from "./poll-status.mjs";
import { startDispatcher } from "./integrations/tfs-server.mjs";
import { loadConfig, loadUserProfile } from "./context.mjs";
import { loadState, saveState, markFirstRead, logActivity, DATA_DIR } from "./state.mjs";

const STOP_FILE = join(DATA_DIR, "STOP");
const HEARTBEAT_FILE = join(DATA_DIR, "heartbeat.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chats that failed to open this run — skipped on later ticks to avoid log spam.
const unopenable = new Set();
let reactionChatCursor = 0;

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
  const activatedAt = new Date().toISOString();
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
    const policy = replyPolicy(config);
    const whitelist = new Set(policy.mode === "whitelist" ? policy.entries : []);
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
      await tick({ config, brain, userProfile, whitelist, echoLoop, activatedAt });
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

export async function tick({ config, brain, userProfile, whitelist = new Set(), echoLoop, activatedAt, io = { getUnreadChats, readChat, sendMessage } }) {
  const poll = createPoll(config.pollIntervalMs || 15000);
  await poll.update();
  let failure = null;
  try {
    // Echo mode only revisits explicitly allowed chats, never the complement of a blacklist.
    const targets = echoLoop ? [...whitelist] : await io.getUnreadChats(config.port);
    const state = await loadState();
    let reactionRevisit = null;
    // Revisit one chat observed during this activation: reactions need not mark it unread.
    // Bounded work keeps unread messages first and avoids walking historical chats.
    if (!echoLoop && activatedAt) {
      const observed = Object.keys(state.chats || {}).filter(chat => state.chats[chat]?.reactionSnapshot?.activationId === activatedAt && !targets.includes(chat) && !unopenable.has(chat));
      if (observed.length) {
        reactionRevisit = observed[reactionChatCursor++ % observed.length];
        targets.push(reactionRevisit);
      }
    }
    await poll.update({ targets: targets.length, status: "processing", stage: "Reading chats" });
    if (!targets.length) return;
    for (const chat of targets) {
      if (unopenable.has(chat)) { poll.state.skipped++; continue; }
      await poll.update({ currentChat: chat, stage: "Reading message" });
      try {
        const result = await processChat({ chat, config, brain, userProfile, state, echoLoop, activatedAt, poll, io });
        poll.state.examined++;
        if (result === "duplicate") poll.state.duplicates++;
        else if (["empty", "self", "before_activation", "invalid_time"].includes(result)) poll.state.skipped++;
        else poll.state.handled++;
      } catch (e) {
        poll.state.errors++;
        await logActivity({ kind: "poll_error", pollId: poll.state.id, chat, error: e.message });
        console.error(`[${chat}] skipped: ${e.message}`);
        if (chat !== reactionRevisit && /not found in rail/.test(e.message)) unopenable.add(chat);
      }
    }
    await saveState(state);
  } catch (e) {
    failure = e;
    poll.state.errors++;
    throw e;
  } finally { await poll.finish(failure); }
}

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isSelfAuthored(author, mentionNames) {
  const normalized = normalizeIdentity(author);
  return normalized === "you" || (mentionNames || []).some((name) => normalizeIdentity(name) === normalized);
}

export async function processChat({ chat, config, brain, userProfile, state, echoLoop, activatedAt, poll, io = { readChat, sendMessage } }) {
  const { messages } = await io.readChat(chat, 15, config.port);
  if (!messages?.length) return "empty";
  const mentionNames = config.alerts?.mentionNames || [];
  const selfChatName = normalizeIdentity(chat).replace(/\s*\(you\)$/, "");
  const selfChat = isSelfAuthored(selfChatName, mentionNames);
  state.chats ||= {};
  state.chats[chat] ||= {};
  const reactions = reactionMessages(messages, state.chats[chat], activatedAt || 'test-session');
  // Keep self-chat/echo testing. In other chats an outgoing post or edit must
  // neither invoke the brain nor mask a newly received message immediately before it.
  const candidates = echoLoop || selfChat ? messages : messages.filter(m => !isSelfAuthored(m.author, mentionNames));
  const latest = candidates[candidates.length - 1];
  const prevSeen = state.chats?.[chat]?.lastSeen;
  let skipped = latest ? null : 'self';
  if (latest && !echoLoop) {
    if (prevSeen && prevSeen.time === latest.time && prevSeen.author === latest.author && prevSeen.text === latest.text) skipped = 'duplicate';
    if (!selfChat && prevSeen && isSelfAuthored(prevSeen.author, mentionNames) && Date.parse(prevSeen.time) >= Date.parse(latest.time)) skipped = 'duplicate';
    if (activatedAt && !Number.isFinite(Date.parse(latest.time))) skipped = 'invalid_time';
    else if (activatedAt && Date.parse(latest.time) < Date.parse(activatedAt)) skipped = 'before_activation';
  }
  if (latest) await markFirstRead(state, chat, latest);
  if (['before_activation', 'invalid_time'].includes(skipped) && (!prevSeen || prevSeen.time !== latest.time || prevSeen.text !== latest.text)) {
    await logActivity({ kind: 'message_skipped', chat, reason: skipped, messageTime: latest.time, activatedAt });
  }
  if (!skipped) await processMessage({ chat, config, brain, userProfile, state, echoLoop, poll, io, latest, messages });
  // Separate handling traces, without replacing lastSeen for the original message.
  for (const reaction of reactions) await processMessage({ chat, config, brain, userProfile, state, echoLoop, poll, io, latest: reaction, messages });
  return reactions.length || !skipped ? 'handled' : skipped;
}

async function processMessage({ chat, config, brain, userProfile, state, echoLoop, poll, io, latest, messages }) {
  const flowId = randomUUID();
  const flowStartedAt = new Date().toISOString();
  let effectCount = 0;
  const flow = async (stage, fields = {}) => {
    await logActivity({ kind: "flow", flowId, flowStartedAt, pollId: poll?.state.id, stage, chat, ...fields });
    await poll?.update({ stage, currentChat: chat });
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
      await logActivity({ kind: "alert", flowId, flowStartedAt, chat, latest, skipped: reason });
      await recordEffect("ignored", "ignored", { reason });
      return;
    }
    const reason = "alerts.notifyAll enabled; brain bypassed";
    await flow("decision", { action: "alarm", reason });
    const results = await runActions(
      [{ name: "alert_phone", args: { chat, author: latest.author, text: latest.text, time: latest.time } }],
      { chat, latest }
    );
    await logActivity({ kind: "alert", flowId, flowStartedAt, chat, latest, results });
    await recordEffect("phone_alert", actionStatus(results), { reason, results });
    console.error(`[${chat}] alert — ${results[0]?.error || "sent"}`);
    return;
  }

  const whitelisted = isReplyAllowed(config, chat);
  await flow("policy", { action: whitelisted ? "allowed" : "blocked", reason:
    `Teams reply ${whitelisted ? "allowed" : "blocked"} by ${replyPolicy(config).mode}. Phone alerts are unaffected.` });
  let decision;
  try {
    decision = await decideWithRules(
      {
        chat,
        latest,
        history: messages,
        userProfile,
        whitelisted,
        config,
      },
      brain, {
        onRules: (result) => flow("policy", { source: "rules", reason: `Matched rules: ${result.matchedRuleIds.join(', ')}`, ruleEvaluations: result.evaluations }),
        onReviewError: (payload) => flow("error", { source: "rule_review", ...payload }),
        onInput: (payload) => flow("brain_input", payload),
        onOutput: (payload) => flow("brain_output", payload),
        onDecision: ({ decision: d }) => flow("decision", {
          action: d.action,
          reason: d.reason,
          reply: d.reply || null,
          invokeActions: d.invokeActions || [],
          ruleActions: d.ruleActions,
          ruleEvaluations: d.ruleEvaluations,
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
    flowStartedAt,
    chat,
    whitelisted,
    latest,
    action: decision.action,
    reason: decision.reason,
    reply: decision.reply || null,
  });
  console.error(`[${chat}] ${decision.action} — ${decision.reason}`);

  if (decision.action === "rule_actions") {
    const executed = new Set();
    for (const proposal of decision.ruleActions) {
      const { action, ruleId, outcome, reason } = proposal;
      if (['cancelled', 'blocked_reply_policy'].includes(outcome) || action.type === 'ignore') {
        await recordEffect('rule_skipped', 'ignored', { ruleId, reason, outcome }); continue;
      }
      const key = JSON.stringify(action);
      if (executed.has(key)) {
        await recordEffect('rule_duplicate', 'ignored', { ruleId, reason: 'Identical action already attempted for this message' }); continue;
      }
      // Recheck at execution time: a permission change while awaiting review wins.
      if (action.type === 'reply') {
        let currentConfig;
        try { currentConfig = await (io.loadConfig || loadConfig)(); }
        catch (error) {
          await recordEffect('rule_skipped', 'error', { ruleId, reason: 'Cannot verify current reply permission', detail: error.message }); continue;
        }
        if (!whitelisted || !isReplyAllowed(currentConfig, chat)) {
          await recordEffect('rule_skipped', 'ignored', { ruleId, reason: 'Teams reply policy blocks this reply', outcome: 'blocked_reply_policy' }); continue;
        }
      }
      executed.add(key);
      if (action.type === 'alert_phone') {
        const results = await runActions([{ name: 'alert_phone', args: { chat, author: latest.author, text: action.text || latest.text, time: latest.time } }], { chat, latest });
        await logActivity({ kind: 'alert', flowId, flowStartedAt, chat, latest, ruleId, reason, results });
        await recordEffect('phone_alert', actionStatus(results), { ruleId, reason, results });
      } else if (action.type === 'reply') {
        try {
          const result = await io.sendMessage(action.text, config.port);
          await logActivity({ kind: 'send', flowId, flowStartedAt, chat, text: action.text, ruleId, result });
          await recordEffect('teams_reply', result === 'sent' ? 'ok' : 'error', { ruleId, text: action.text, result });
        } catch (error) {
          await recordEffect('teams_reply', 'error', { ruleId, text: action.text, detail: error.message });
        }
      }
    }
    if (!effectCount) await recordEffect('none', 'ignored', { reason: 'No configured or permitted agent action' });
    return;
  }

}
