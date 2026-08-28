from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"target not found: {label}")
    return text.replace(old, new, 1)


# ---- brain.mjs -------------------------------------------------------------
brain_path = Path("src/brain.mjs")
brain = brain_path.read_text()
brain = replace_once(
    brain,
    'import { listActions } from "./actions.mjs";\n',
    'import { listActions } from "./actions.mjs";\n\nasync function emitTrace(trace, name, payload) {\n  const fn = trace?.[name];\n  if (typeof fn !== "function") return;\n  try { await fn(payload); } catch { /* observability must never change a brain decision */ }\n}\n',
    "brain trace helper",
)

stub_start = brain.index("async function stubDecide(input) {")
stub_end = brain.index("\n// ---- gemini", stub_start)
stub = '''async function stubDecide(input, trace = {}) {
  const text = input.latest?.text || "";
  await emitTrace(trace, "onInput", {
    provider: "stub",
    model: null,
    mode: input.config?.automation?.mode || "respond",
    input: {
      chat: input.chat,
      latest: input.latest,
      history: input.history,
      userProfile: input.userProfile,
      whitelisted: input.whitelisted,
    },
  });

  let decision;
  if (input.config?.automation?.mode === "alert-only") {
    const alarm = ESCALATE_PATTERNS.some((re) => re.test(text));
    decision = {
      action: alarm ? "alarm" : "ignore",
      reply: null,
      invokeActions: [],
      reason: alarm
        ? "stub: message matches an alarm pattern."
        : "stub: no alarm pattern matched.",
    };
  } else if (ESCALATE_PATTERNS.some((re) => re.test(text))) {
    decision = {
      action: "escalate",
      reply: null,
      invokeActions: [],
      reason: "stub: message matches an escalation pattern (needs the human).",
    };
  } else if (input.whitelisted) {
    decision = {
      action: "respond",
      reply: `(auto) Got it: "${text.slice(0, 80)}"`,
      invokeActions: [],
      reason: "stub: whitelisted chat, no escalation trigger — auto-acknowledged.",
    };
  } else {
    decision = {
      action: "hold",
      reply: null,
      invokeActions: [],
      reason: "stub: not whitelisted and nothing urgent — hold + escalate for review.",
    };
  }

  await emitTrace(trace, "onDecision", { decision });
  return decision;
}
'''
brain = brain[:stub_start] + stub + brain[stub_end:]

old_gemini = '''  return async function geminiDecide(input) {
    if (!apiKey) {
      throw new Error(
        `Brain provider "gemini" needs an API key in env ${apiKeyEnv}.`
      );
    }
    const { system, user } = buildPrompt(input);
    const raw = await callGemini({ model, apiKey, system, user });
    return parseDecision(raw, input.config?.automation?.mode);
  };'''
new_gemini = '''  return async function geminiDecide(input, trace = {}) {
    if (!apiKey) {
      throw new Error(
        `Brain provider "gemini" needs an API key in env ${apiKeyEnv}.`
      );
    }
    const { system, user } = buildPrompt(input);
    await emitTrace(trace, "onInput", { provider: "gemini", model, system, user });
    const raw = await callGemini({ model, apiKey, system, user });
    await emitTrace(trace, "onOutput", { provider: "gemini", model, raw });
    const decision = parseDecision(raw, input.config?.automation?.mode);
    await emitTrace(trace, "onDecision", { decision });
    return decision;
  };'''
brain = replace_once(brain, old_gemini, new_gemini, "gemini traced decide")

old_generic = '''  return async function llmDecide(input) {
    // eslint-disable-next-line no-unused-vars
    const { system, user } = buildPrompt(input);
    const apiKey = process.env[config?.brain?.apiKeyEnv || "ANTHROPIC_API_KEY"];'''
new_generic = '''  return async function llmDecide(input, trace = {}) {
    const { system, user } = buildPrompt(input);
    await emitTrace(trace, "onInput", {
      provider,
      model: config?.brain?.model || "",
      system,
      user,
    });
    const apiKey = process.env[config?.brain?.apiKeyEnv || "ANTHROPIC_API_KEY"];'''
brain = replace_once(brain, old_generic, new_generic, "generic traced decide")
brain_path.write_text(brain)


# ---- orchestrator.mjs ------------------------------------------------------
orch_path = Path("src/orchestrator.mjs")
orch = orch_path.read_text()
orch = replace_once(
    orch,
    'import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";\n',
    'import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";\nimport { randomUUID } from "node:crypto";\n',
    "orchestrator randomUUID import",
)

start = orch.index("async function processChat(")
end = orch.index("\nasync function holdAndEscalate", start)
new_process = r'''async function processChat({ chat, config, brain, userProfile, whitelist, state, echoLoop }) {
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
'''
orch = orch[:start] + new_process + orch[end:]

hold_start = orch.index("async function holdAndEscalate(")
new_hold = r'''async function holdAndEscalate(config, chat, latest, reason, flowId, recordEffect) {
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
'''
orch = orch[:hold_start] + new_hold
orch_path.write_text(orch)


# ---- gui-server-core.mjs ---------------------------------------------------
core_path = Path("src/gui-server-core.mjs")
core = core_path.read_text()
core = replace_once(
    core,
    "async function apiActivity(limit) {\n  const lines = await tailLines(ACTIVITY_LOG);",
    "async function apiActivity(limit) {\n  // Brain prompts/raw output make flow records substantially larger than the old\n  // activity entries. Keep enough tail bytes for dozens of complete flows.\n  const lines = await tailLines(ACTIVITY_LOG, 2_097_152);",
    "activity tail size",
)
core_path.write_text(core)


# ---- gui-server.mjs --------------------------------------------------------
gui_path = Path("src/gui-server.mjs")
gui = gui_path.read_text()
gui = replace_once(
    gui,
    'import { authOk, logDiagnostic, redactSecrets, requestMeta, tailLines, tokenMatches } from "./gui-diagnostics.mjs";\n',
    'import { authOk, logDiagnostic, redactSecrets, requestMeta, tailLines, tokenMatches } from "./gui-diagnostics.mjs";\nimport { injectObservability } from "./gui-observability-ui.mjs";\n',
    "observability UI import",
)
ui_start = gui.index("const DIAGNOSTICS_HTML = `")
ui_end = gui.index("\nexport function startGui", ui_start)
gui = gui[:ui_start] + gui[ui_end:]
gui = gui.replace("injectDiagnostics(chunk)", "injectObservability(chunk)")
gui = gui.replace("injectDiagnostics(chunk.toString(\"utf8\"))", "injectObservability(chunk.toString(\"utf8\"))")
if "injectDiagnostics" in gui:
    raise SystemExit("stale injectDiagnostics reference remains")
gui_path.write_text(gui)


# ---- smoke-gui.mjs ---------------------------------------------------------
smoke_path = Path("scripts/smoke-gui.mjs")
smoke = smoke_path.read_text()
smoke = replace_once(
    smoke,
    'import { startGui } from "../src/gui-server.mjs";\n',
    'import { startGui } from "../src/gui-server.mjs";\nimport { createBrain } from "../src/brain.mjs";\n',
    "smoke brain import",
)
insert_at = smoke.index("\nawait testChildProcess();")
trace_test = r'''
async function testBrainTrace() {
  const seen = [];
  const brain = createBrain({ brain: { provider: "stub" }, automation: { mode: "alert-only" } });
  const decision = await brain.decide(
    {
      chat: "Smoke Chat",
      latest: { author: "Someone", time: "now", text: "urgent: please call" },
      history: [{ author: "Someone", time: "now", text: "urgent: please call" }],
      userProfile: "alarm on direct requests",
      whitelisted: false,
      config: { automation: { mode: "alert-only" } },
    },
    {
      onInput: (x) => seen.push(["input", x]),
      onOutput: (x) => seen.push(["output", x]),
      onDecision: (x) => seen.push(["decision", x]),
    }
  );
  if (decision.action !== "alarm") throw new Error("stub trace decision did not alarm");
  if (!seen.some(([kind, x]) => kind === "input" && x.provider === "stub")) {
    throw new Error("brain trace input callback missing");
  }
  if (!seen.some(([kind, x]) => kind === "decision" && x.decision?.action === "alarm")) {
    throw new Error("brain trace decision callback missing");
  }
}
'''
smoke = smoke[:insert_at] + trace_test + smoke[insert_at:]
smoke = smoke.replace("await testChildProcess();", "await testChildProcess();\nawait testBrainTrace();", 1)

needle = '''  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }

  ws = new WebSocket'''
replacement = '''  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }

  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const page = await pageResponse.text();
  for (const marker of ['id="pipeline"', 'id="diagnosticsEvents"', "Message pipeline"]) {
    if (!page.includes(marker)) throw new Error(`observability UI marker missing: ${marker}`);
  }
  for (const match of page.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)) {
    // Compile browser scripts without executing them; catches malformed injected JS.
    new Function(match[1]);
  }

  ws = new WebSocket'''
smoke = replace_once(smoke, needle, replacement, "smoke page observability test")
smoke = smoke.replace(
    'console.log("Bun child_process + GUI WebSocket smoke tests passed.");',
    'console.log("Bun child_process + brain trace + observability UI + GUI WebSocket smoke tests passed.");',
    1,
)
smoke_path.write_text(smoke)
