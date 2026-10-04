import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CONFIG_FILE, DATA_DIR, LOCAL_HOME } from "../src/local-paths.mjs";
import { replyPolicy, isReplyAllowed, validateReplyPolicy } from "../src/reply-policy.mjs";
import { createPoll, readPoll } from "../src/poll-status.mjs";
import { startGui } from "../src/gui-server.mjs";
import { agentStore, messageKey } from "../src/agent/store.mjs";
import { POLICY_FILE } from "../src/agent/policy.mjs";

assert(LOCAL_HOME.includes("teams-monitor-smoke-"));
assert.deepEqual(replyPolicy({}), { mode: "whitelist", entries: [] });
assert.equal(isReplyAllowed({}, "Alex"), false);
assert.equal(isReplyAllowed({ whitelist: { autoSend: ["Alex"] } }, "alex"), true);
assert.equal(isReplyAllowed({ replyPolicy: { mode: "bad", entries: ["Alex"] } }, "Alex"), false);
assert.equal(isReplyAllowed({ replyPolicy: { mode: "blacklist", entries: [] } }, ""), false);
assert.throws(() => validateReplyPolicy({ mode: "blacklist", entries: [""] }));

const serve = process.argv.includes("--serve");
const port = serve ? 18091 : 18092;
process.env.DASHBOARD_TEST_TOKEN = serve ? "" : "dashboard-test-token";
const config = Bun.YAML.parse(await readFile(CONFIG_FILE, "utf8"));
config.gui = { ...config.gui, host: "127.0.0.1", port, authTokenEnv: "DASHBOARD_TEST_TOKEN" };
const { server, close } = startGui(config);
if (!server.listening) await new Promise(resolve => server.once("listening", resolve));

const request = (path, method = "GET", body, auth = true) => fetch(`http://127.0.0.1:${port}${path}`, {
  method,
  headers: { Authorization: auth ? "Bearer dashboard-test-token" : "", "Content-Type": "application/json" },
  ...(body == null ? {} : { body: JSON.stringify(body) }),
});

const now = Date.now();
const auditFixture = [{ kind: "flow", flowId: "dashboard-fixture", flowStartedAt: new Date(now - 60000).toISOString(), at: new Date(now - 60000).toISOString(), stage: "message", chat: "Test chat", latest: { author: "Jordan", text: "A retained dashboard fixture." } }];
await writeFile(join(DATA_DIR, "activity.jsonl"), auditFixture.map(row => JSON.stringify(row)).join("\n") + "\n");
const poll = createPoll(5000);
await poll.update({ targets: 2, examined: 2, handled: 1, status: "processing" });
await poll.finish();

const db = agentStore();
try {
  if (!serve) {
    for (const [path, method, body] of [
      ["/api/reply-policy", "GET"], ["/api/poll", "GET"], ["/api/activity/view", "GET"],
      ["/api/agent/policy", "GET"], ["/api/agent/status", "GET"], ["/api/agent/notes", "GET"],
      ["/api/agent/permissions", "GET"], ["/api/agent/permissions", "PUT", { source: "tools: []" }],
      ["/api/agent/sandbox", "GET"], ["/api/agent/sandbox", "PUT", { source: "timeoutMs: 1000" }],
      ["/api/agent/note?path=test.md", "GET"], ["/api/agent/brief?chat=Test%20chat", "GET"],
      ["/api/agent/intervene", "POST", { prompt: "unauthorized", conversationId: 'test' }],
      ["/api/agent/conversation?id=test", "GET"], ["/api/agent/conversation/reset", "POST", { conversationId: 'test' }],
      ["/api/agent/run/cancel", "POST", { runId: 'test' }],
    ]) assert.equal((await request(path, method, body, false)).status, 401, `auth required for ${path}`);
  }

  assert.equal((await request("/api/reply-policy", "PUT", { mode: "blacklist", entries: ["Alex"] })).status, 200);
  assert.deepEqual(await (await request("/api/reply-policy")).json(), { mode: "blacklist", entries: ["Alex"] });
  assert.equal((await request("/api/reply-policy", "PUT", { mode: "all", entries: [] })).status, 400);
  assert.deepEqual(await (await request("/api/reply-policy")).json(), { mode: "blacklist", entries: ["Alex"] });

  const pollState = await (await request("/api/poll")).json();
  assert.equal(pollState.status, "completed");
  assert.equal(pollState.handled, 1);
  assert.equal((await request("/api/poll", "POST", {})).status, 405);

  const originalPolicyResponse = await request("/api/agent/policy");
  assert.equal(originalPolicyResponse.status, 200);
  const originalPolicy = await originalPolicyResponse.json();
  assert.equal(typeof originalPolicy.source, "string");
  assert.equal(originalPolicy.path, POLICY_FILE, "policy link points to the active application home's file");
  assert.equal(originalPolicy.editorUrl, 'vscode://file' + pathToFileURL(POLICY_FILE).pathname);
  assert.equal(originalPolicy.version, createHash("sha256").update(originalPolicy.source).digest("hex"));
  assert.equal((await request("/api/agent/policy", "POST", {})).status, 400);
  const harmlessPolicy = 'export async function handle(ctx, actions) { await actions.alert("replay-only"); }';
  const saved = await request("/api/agent/policy", "PUT", { source: harmlessPolicy });
  assert.equal(saved.status, 200);
  const savedPolicy = await saved.json();
  assert.equal(savedPolicy.source, harmlessPolicy);
  assert.equal(savedPolicy.path, POLICY_FILE);
  assert.equal(savedPolicy.editorUrl, originalPolicy.editorUrl);
  assert.equal(savedPolicy.version, createHash("sha256").update(harmlessPolicy).digest("hex"));
  const policyOnDisk = await readFile(POLICY_FILE, "utf8");
  assert.equal(policyOnDisk, harmlessPolicy);
  const badPolicy = await request("/api/agent/policy", "PUT", { source: "export const handle = 7;" });
  assert.equal(badPolicy.status, 400);
  assert.equal(await readFile(POLICY_FILE, "utf8"), policyOnDisk, "invalid policy save keeps the active source");
  assert.deepEqual(await (await request("/api/agent/policy")).json(), savedPolicy);

  const originalPermissions = await (await request('/api/agent/permissions')).json();
  const configBeforePermissions = Bun.YAML.parse(await readFile(CONFIG_FILE, 'utf8'));
  const ceiling = { tools: ['list_conversations', 'read_note'], readChats: ['Test chat'], writeChats: [],
    initiateActions: [], cancelIds: [], modifyIds: {} };
  assert.equal((await request('/api/agent/permissions', 'PUT', { source: Bun.YAML.stringify(ceiling) })).status, 200);
  assert.deepEqual(Bun.YAML.parse((await (await request('/api/agent/permissions')).json()).source), ceiling);
  const savedConfigText = await readFile(CONFIG_FILE, 'utf8');
  const savedConfig = Bun.YAML.parse(savedConfigText);
  assert.deepEqual(savedConfig.agent.ceiling, ceiling);
  assert.deepEqual({ ...savedConfig, agent: configBeforePermissions.agent }, configBeforePermissions, 'Ceiling saves retain unrelated configuration');
  for (const source of ['tools: [', 'tools: []', '[]', Bun.YAML.stringify({ ...ceiling, unknown: true }),
    Bun.YAML.stringify({ ...ceiling, tools: ['execute_arbitrary_code'] }), Bun.YAML.stringify({ ...ceiling, readChats: null }),
    Bun.YAML.stringify({ ...ceiling, modifyIds: { '*': ['destination'] } })]) {
    assert.equal((await request('/api/agent/permissions', 'PUT', { source })).status, 400);
    assert.equal(await readFile(CONFIG_FILE, 'utf8'), savedConfigText, 'Invalid ceiling does not alter saved configuration');
  }
  assert.equal((await request('/api/agent/permissions', 'PUT', originalPermissions)).status, 200);

  const originalSandbox = await (await request('/api/agent/sandbox')).json();
  assert.equal(originalSandbox.available, false, 'Isolated home has no installed helper');
  const newLimits = { ...Bun.YAML.parse(originalSandbox.source), timeoutMs: 700, memoryMb: 256 };
  assert.equal((await request('/api/agent/sandbox', 'PUT', { source: Bun.YAML.stringify(newLimits) })).status, 200);
  assert.deepEqual(Bun.YAML.parse((await (await request('/api/agent/sandbox')).json()).source), newLimits);
  const configAfterSandbox = await readFile(CONFIG_FILE, 'utf8');
  for (const source of ['[]', 'timeoutMs: 0', 'cpuPercent: 100', 'memoryMb: 4', 'unknown: true', 'timeoutMs: broken']) {
    assert.equal((await request('/api/agent/sandbox', 'PUT', { source })).status, 400);
    assert.equal(await readFile(CONFIG_FILE, 'utf8'), configAfterSandbox);
  }
  assert.equal((await request('/api/agent/sandbox', 'PUT', { source: originalSandbox.source })).status, 200);

  const agentState = await (await request("/api/agent/status")).json();
  assert.equal(agentState.mode, "active");
  assert.equal(agentState.current, null);
  assert(Array.isArray(agentState.records) && Array.isArray(agentState.actions) && Array.isArray(agentState.conversations));
  db.record('corrupt-fixture', 'agent_result', null);
  db.record('corrupt-fixture', 'policy_input', 7);
  const corrupted = await request('/api/agent/status');
  assert.equal(corrupted.status, 200, 'invalid record shapes must not break status');
  assert.equal((await corrupted.json()).records.filter(row => row.kind === 'invalid_log').length, 2);
  assert.equal((await request("/api/agent/mode", "PUT", { mode: "read_only" })).status, 200);
  assert.equal((await (await request("/api/agent/status")).json()).mode, "read_only");
  assert.equal((await request("/api/agent/mode", "PUT", { mode: "paused" })).status, 200);
  assert.equal((await request("/api/agent/mode", "PUT", { mode: "active" })).status, 200);
  assert.equal((await request("/api/agent/mode", "PUT", { mode: "invalid" })).status, 400);

  assert.equal((await request('/api/agent/prompt', 'POST', { prompt: 'no standalone prompt endpoint' })).status, 400);
  assert.equal((await request('/api/agent/intervene', 'POST', { prompt: 'unknown', conversationId: 'unknown' })).status, 400);
  db.session('test', { history: [], summary: '', permissions: ceiling, readChats: ceiling.readChats });
  const prompt = await request("/api/agent/intervene", "POST", { prompt: "Return a summary only.", conversationId: 'test' });
  assert.equal(prompt.status, 200);
  const queuedPrompt = await prompt.json();
  assert.equal(queuedPrompt.state, "pending");
  assert(queuedPrompt.id);
  assert.equal((await (await request('/api/agent/conversation?id=test')).json()).id, 'test');
  assert.equal((await request('/api/agent/conversation/reset', 'POST', { conversationId: 'test' })).status, 200);
  assert.equal((await (await request('/api/agent/conversation?id=test')).json()).archives.length, 1);
  assert.equal((await request('/api/agent/run/cancel', 'POST', { runId: 'test' })).status, 400);

  assert.deepEqual(await (await request("/api/agent/notes")).json(), { notes: [] });
  const savedNote = await request("/api/agent/note", "PUT", { path: "people/jordan.md", text: "Prefers concise updates." });
  assert.equal(savedNote.status, 200);
  assert.deepEqual(await (await request("/api/agent/note?path=people%2Fjordan.md")).json(), { path: "people/jordan.md", text: "Prefers concise updates." });
  assert.deepEqual(await (await request("/api/agent/notes")).json(), { notes: [{ path: "people/jordan.md" }] });
  assert.equal((await request("/api/agent/note", "PUT", { path: "../escape.md", text: "no" })).status, 400);

  assert.deepEqual(await (await request("/api/agent/brief?chat=Test%20chat")).json(), { chat: "Test chat", text: "" });
  assert.equal((await request("/api/agent/brief", "PUT", { chat: "Test chat", text: "Release coordination conversation." })).status, 200);
  assert.deepEqual(await (await request("/api/agent/brief?chat=Test%20chat")).json(), { chat: "Test chat", text: "Release coordination conversation." });

  const wake = await request("/api/agent/wake", "POST", { prompt: "Check the open question.", dueAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(wake.status, 200);
  const wakeJob = await wake.json();
  assert.equal(wakeJob.state, "pending");
  assert((await (await request("/api/agent/status")).json()).actions.some(action => action.id === wakeJob.id && action.state === "pending"));
  assert.equal((await request(`/api/agent/actions/${wakeJob.id}/cancel`, "POST", {})).status, 200);
  assert.equal((await request(`/api/agent/actions/${wakeJob.id}/cancel`, "POST", {})).status, 400);
  assert.equal((await request("/api/agent/wake", "POST", { prompt: "Late", dueAt: new Date(Date.now() - 1000).toISOString() })).status, 400);

  const message = { author: "Jordan", text: "A recorded message for isolated replay.", time: new Date(Date.now() - 30000).toISOString() };
  const messageId = messageKey("Test chat", message);
  db.observe("Test chat", message, false);
  const liveActionCount = db.actions().length;
  const replay = await request("/api/agent/replay", "POST", { messageId });
  assert.equal(replay.status, 200);
  const replayResult = await replay.json();
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.replay, true);
  assert.equal(replayResult.externalActionsDisabled, true);
  assert.equal(replayResult.actions[0].kind, "alert", "replay may propose an action for inspection");
  assert.equal(db.actions().length, liveActionCount, "replay proposals remain in its in-memory store");
  assert.equal((await request("/api/agent/replay", "POST", { messageId: "not-found" })).status, 400);

  const activityBefore = await (await request("/api/activity?limit=500")).json();
  const auditBefore = await readFile(join(DATA_DIR, "activity.jsonl"), "utf8");
  assert.equal(activityBefore.length, 1);
  const through = new Date().toISOString();
  assert.equal((await request("/api/activity/view", "PUT", { through: "bad" })).status, 400);
  assert.equal((await request("/api/activity/view", "PUT", { through })).status, 200);
  assert.equal((await (await request("/api/activity/view")).json()).clearedThrough, through);
  assert.deepEqual(await (await request("/api/activity?limit=500")).json(), []);
  assert.equal(await readFile(join(DATA_DIR, "activity.jsonl"), "utf8"), auditBefore, "activity filter leaves the audit log intact");
  assert.equal((await request("/api/activity/view", "PUT", { through: null })).status, 200);
  assert.deepEqual(await (await request("/api/activity?limit=500")).json(), activityBefore);

  const page = await (await request("/")).text();
  assert(!page.includes("Monitor dashboard"));
  assert(page.includes('id="pauseUpdates"') && page.includes('id="clearActivity"'));
  assert(page.includes('id="activitySince"'));
  assert(page.includes('id="rulesForm"') && page.includes('id="alertRules"'));
  assert(page.includes('<a id="policyFile" class="policy-file">policy.mjs</a>'));
  assert(page.includes('link.textContent = policy.path') && page.includes('link.href = policy.editorUrl'));
  assert(page.includes("JavaScript policy") && !page.includes("Automation config YAML"));
  assert(page.includes('id="agentHeading"') && page.includes('id="agentMode"'));
  assert(page.includes('id="agentReplayForm"') && page.includes('id="agentWakeForm"'));
  assert(page.includes('id="agentInterveneForm"') && page.includes('id="agentConversationSelect"'));
  assert(!page.includes('id="agentPromptForm"'));
  assert(page.includes('id="agentNoteSelect"') && page.includes('id="agentBriefSave"'));
  assert(page.includes('function syncAgentRecordList(panel, rows, makeRow)'));
  assert.match(page, /syncAgentRecordList\(\$\(['"]agentRecords['"]\)/);
  assert(page.includes("Paused stops model runs") && page.includes("Read-only prevents model-originated"));
  assert(!page.includes('id="heuristicsForm"'));
  for (const script of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script[1]);

  console.log("Dashboard auth, poll/reply policy, atomic JS policy, replay, agent controls, notes/briefs/wakes, activity filtering, and embedded script: passed.");
  if (serve) {
    await writeFile(join(DATA_DIR, "activity.jsonl"), auditFixture.map(row => JSON.stringify(row)).join("\n") + "\n");
    await request("/api/reply-policy", "PUT", { mode: "whitelist", entries: [] });
    console.log("Isolated browser preview: http://127.0.0.1:18091");
    await new Promise(() => {});
  }
} finally {
  db.close();
  await close();
}
