import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, DATA_DIR, LOCAL_HOME } from "../src/local-paths.mjs";
import { replyPolicy, isReplyAllowed, validateReplyPolicy } from "../src/reply-policy.mjs";
import { processChat, tick } from "../src/orchestrator.mjs";
import { createBrain } from "../src/brain.mjs";
import { validateAutomation } from "../src/deterministic-rules.mjs";
import { readPoll } from "../src/poll-status.mjs";
import { registerAction } from "../src/actions.mjs";
import { startGui } from "../src/gui-server.mjs";

assert(LOCAL_HOME.includes('teams-monitor-smoke-'));
assert.deepEqual(replyPolicy({}), { mode: "whitelist", entries: [] });
assert.equal(isReplyAllowed({}, "Alex"), false);
assert.equal(isReplyAllowed({ whitelist: { autoSend: ["Alex"] } }, "alex"), true);
assert.equal(isReplyAllowed({ replyPolicy: { mode: "bad", entries: ["Alex"] } }, "Alex"), false);
assert.equal(isReplyAllowed({ replyPolicy: { mode: "blacklist", entries: [] } }, ""), false);
assert.throws(() => validateReplyPolicy({ mode: "blacklist", entries: [""] }));

let sent = 0, phone = 0;
registerAction({ name: "alert_phone", run: async () => { phone++; return { sent: true }; } });
const latest = { author: "Alex", text: "A test message", time: "2026-01-01T10:00:00Z" };
const io = { readChat: async () => ({ messages: [latest] }), sendMessage: async () => { sent++; return "sent"; } };
for (const action of ["configured", "initiated"]) {
  for (const [policy, expected] of [
    [undefined, 0], [{ mode: "whitelist", entries: [] }, 0],
    [{ mode: "whitelist", entries: ["Alex"] }, 1],
    [{ mode: "blacklist", entries: ["Alex"] }, 0],
    [{ mode: "blacklist", entries: [] }, 1],
  ]) {
    sent = 0;
    const cfg = { automation: action === 'configured'
      ? { rules: [{ id: 'reply', when: { type: 'direct_message' }, action: { type: 'reply', text: 'Reply' } }] }
      : { agent: { initiate: { when: 'always', actions: ['reply'] } } }, replyPolicy: policy, alerts: {} };
    await processChat({ chat: "Alex", config: cfg, state: { chats: {} }, io: { ...io, loadConfig: async () => cfg },
      brain: { reviewPlan: async () => ({ changes: [], additions: [{ action: { type: 'reply', text: 'Reply' }, reason: 'Test' }], reason: 'Test' }) } });
    assert.equal(sent, expected, `${action}: ${JSON.stringify(policy)}`);
  }
}
sent = 0; phone = 0;
const protectedConfig = { replyPolicy: { mode: "whitelist", entries: [] }, alerts: {}, automation: { rules: [{ id: 'direct', when: { type: 'direct_message' }, action: { type: 'alert_phone' } }] } };
await processChat({ chat: "Alex", config: protectedConfig,
  state: { chats: {} }, io, brain: { reviewPlan: async () => { throw Error('Must bypass'); } } });
assert.equal(sent, 0, "empty whitelist prevents Teams replies");
assert.equal(phone, 1, "empty whitelist does not block protected phone rules");

const config = { automation: { rules: [{ id: 'quiet', when: { field: "chat", match: "exact", value: "Project updates" }, action: { type: 'ignore' } }] }, pollIntervalMs: 5000, brain: { provider: "stub" } };
const brain = createBrain(config);
const pollIo = { ...io, getUnreadChats: async () => ["Project updates"] };
await tick({ config, brain, io: pollIo });
assert.equal((await readPoll()).handled, 1);
assert.equal((await readPoll()).status, "completed");
await tick({ config, brain, io: pollIo });
assert.equal((await readPoll()).duplicates, 1);
await tick({ config, brain, io: { ...pollIo, getUnreadChats: async () => [] } });
assert.equal((await readPoll()).targets, 0);
assert.ok((await readPoll()).completedAt, "empty polls still complete");
await tick({ config, brain, io: { ...pollIo, readChat: async () => { throw new Error("Test read failure"); } } });
assert.equal((await readPoll()).errors, 1);
await assert.rejects(tick({ config, brain, io: { ...pollIo, getUnreadChats: async () => { throw new Error("Test scan failure"); } } }));
assert.equal((await readPoll()).status, "error");

const serve = process.argv.includes("--serve");
const port = serve ? 18091 : 18092;
process.env.DASHBOARD_TEST_TOKEN = serve ? "" : "dashboard-test-token";
let previewPresence = 'available', presenceRequest = 0;
const previewPresenceApi = {
  get: async () => ({ connected: true, value: previewPresence, status: previewPresence }),
  set: async (status) => {
    if (!['available', 'away', 'offline', 'busy', 'dnd', 'brb'].includes(status)) throw Object.assign(new Error('Invalid status'), { httpCode: 400 });
    const revision = ++presenceRequest;
    await new Promise(r => setTimeout(r, status === 'away' ? 1400 : 400));
    if (revision !== presenceRequest) return { superseded: true, requested: status };
    previewPresence = status;
    return { ok: true, verified: true, value: status, status };
  },
};
const { server, close } = startGui({ gui: { host: "127.0.0.1", port, authTokenEnv: "DASHBOARD_TEST_TOKEN" } }, serve ? previewPresenceApi : undefined);
if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
const request = (path, method = "GET", body, auth = true) => fetch(`http://127.0.0.1:${port}${path}`, {
  method, headers: { Authorization: auth ? "Bearer dashboard-test-token" : "", "Content-Type": "application/json" },
  ...(body == null ? {} : { body: JSON.stringify(body) }),
});
try {
  if (!serve) {
    assert.equal((await request('/api/reply-policy', 'PUT', { mode: 'blacklist', entries: [] }, false)).status, 401);
    assert.equal((await request('/api/poll', 'GET', null, false)).status, 401);
    assert.equal((await request('/api/teams/presence', 'GET', null, false)).status, 401);
    assert.equal((await request('/api/teams/presence', 'PUT', { status: 'busy' }, false)).status, 401);
    assert.equal((await request('/api/activity/view', 'GET', null, false)).status, 401);
    assert.equal((await request('/api/activity/view', 'PUT', { through: new Date().toISOString() }, false)).status, 401);
    assert.equal((await request('/api/policy/automation', 'GET', null, false)).status, 401);
    assert.equal((await request('/api/policy/automation', 'PUT', { rules: [] }, false)).status, 401);
  }
  assert.equal((await request('/api/reply-policy', 'PUT', { mode: 'blacklist', entries: ['Alex'] })).status, 200);
  assert.deepEqual(await (await request('/api/reply-policy')).json(), { mode: 'blacklist', entries: ['Alex'] });
  assert.equal((await request('/api/reply-policy', 'PUT', { mode: 'all', entries: [] })).status, 400);
  assert.deepEqual(await (await request('/api/reply-policy')).json(), { mode: 'blacklist', entries: ['Alex'] });
  assert.equal((await request('/api/profile', 'PUT', { text: 'Test context' })).status, 200);
  assert.equal((await (await request('/api/profile')).json()).text, 'Test context');
  assert.equal((await request('/api/config/alerts', 'PUT', { transport: 'websocket', fallbackTransport: null })).status, 200);
  assert.equal((await request('/api/config/poll-interval', 'PUT', { pollIntervalMs: 5000 })).status, 200);
  assert.equal((await request('/api/config/poll-interval', 'PUT', { pollIntervalMs: 0 })).status, 400);
  assert.equal((await request('/api/teams/presence', 'PUT', { status: 'invalid' })).status, 400);
  assert.equal((await request('/api/teams/presence', 'POST', {})).status, 405);
  const originalAutomation = await (await request('/api/policy/automation')).json();
  assert.equal(originalAutomation.rules.length, 2);
  assert(originalAutomation.rules.every(r => !r.agent.cancel && !r.agent.modify));
  const cfgBefore = Bun.YAML.parse(await readFile(CONFIG_FILE, 'utf8'));
  const edited = validateAutomation({ rules: [{ id: 'example', when: { field: 'text', match: 'contains_number', value: '1234' }, action: { type: 'reply', text: 'Checking' }, agent: { cancel: true, modify: true } }], agent: { initiate: { when: 'always', actions: ['alert_phone'] }, timeoutMs: 7000 } });
  assert.equal((await request('/api/policy/automation', 'PUT', edited)).status, 200);
  assert.deepEqual(await (await request('/api/policy/automation')).json(), edited);
  assert.deepEqual(Bun.YAML.parse(await readFile(CONFIG_FILE, 'utf8')), { ...cfgBefore, automation: edited });
  const savedConfig = await readFile(CONFIG_FILE, 'utf8');
  for (const value of [null, [], { heuristics: {} }, { agent: { timeoutMs: 0 } }, { agent: { initiate: { when: 'always', actions: ['shell'] } } }, { rules: [{ ...edited.rules[0], agent: { cancel: 'true' } }] }, { unexpected: true }]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/policy/automation`, { method: 'PUT', headers: { Authorization: 'Bearer dashboard-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
    assert.equal(await readFile(CONFIG_FILE, 'utf8'), savedConfig);
  }
  assert.equal((await request('/api/policy/automation', 'POST', {})).status, 405);
  assert.equal((await request('/api/policy/automation', 'PUT', originalAutomation)).status, 200);
  assert.deepEqual(await (await request('/api/policy/automation')).json(), originalAutomation);
  assert.equal((await request('/api/policy/automation/yaml', 'GET', null, false)).status, serve ? 200 : 401);
  const originalYaml = (await (await request('/api/policy/automation/yaml')).json()).yaml;
  assert.deepEqual(Bun.YAML.parse(originalYaml), originalAutomation);
  const yamlDraft = '# Configured rule permissions\n' + Bun.YAML.stringify(edited, null, 2);
  const yamlSaved = await request('/api/policy/automation/yaml', 'PUT', { yaml: yamlDraft });
  assert.equal(yamlSaved.status, 200);
  assert.deepEqual(Bun.YAML.parse((await yamlSaved.json()).yaml), edited);
  const beforeInvalidYaml = await readFile(CONFIG_FILE, 'utf8');
  for (const yaml of ['rules: [', '- list instead of mapping', 'rules: []\nagent:\n  timeoutMs: nope', 'rules: &loop [*loop]', 'rules:\n - id: unquoted-number\n   when: { field: text, match: contains_number, value: 1234 }\n   action: { type: alert_phone }']) {
    assert.equal((await request('/api/policy/automation/yaml', 'PUT', { yaml })).status, 400);
    assert.equal(await readFile(CONFIG_FILE, 'utf8'), beforeInvalidYaml);
  }
  await request('/api/policy/automation/yaml', 'PUT', { yaml: originalYaml });
  assert.equal((await (await request('/api/poll')).json()).status, 'error');
  const page = await (await request('/')).text();
  assert(!page.includes('Monitor dashboard'));
  assert(!page.includes('class="section-number"'));
  assert(!page.includes('class="pulse-ring"'));
  assert(page.indexOf('id="pauseUpdates"') < page.indexOf('</header>'));
  assert(page.indexOf('id="refreshButton"') < page.indexOf('</header>'));
  assert(page.includes('id="clearActivity"'));
  assert(page.indexOf('<form id="pollForm"') < page.indexOf('>Cloudflare tunnel</div>'), 'Teams polling belongs before the tunnel section');
  assert(!page.includes('id="presenceForm"'));
  assert(!page.includes('id="setPresence"'));
  assert(!page.includes('id="liveStatus"'));
  assert(page.includes('id="activitySince"'));
  assert(!page.includes('id="heuristicsForm"'));
  assert(page.includes('id="rulesForm"'));
  assert(page.includes('id="advancedTitle"'));
  const advanced = page.slice(page.indexOf('<section class="card" aria-labelledby="advancedTitle"'), page.indexOf('</section>', page.indexOf('<section class="card" aria-labelledby="advancedTitle"')));
  assert(advanced.includes('Automation config YAML'));
  assert(advanced.includes('agent.cancel') && advanced.includes('agent.modify'));
  assert(!advanced.includes('<details') && !advanced.includes('<summary'), 'Advanced alert settings are always visible');
  for (const script of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  const activityBefore = await (await request('/api/activity?limit=500')).json();
  const auditBefore = await readFile(join(DATA_DIR, 'activity.jsonl'), 'utf8');
  assert(activityBefore.length > 0);
  const through = new Date().toISOString();
  assert.equal((await request('/api/activity/view', 'PUT', { through: 'bad' })).status, 400);
  assert.equal((await request('/api/activity/view', 'PUT', { through })).status, 200);
  assert.equal((await (await request('/api/activity/view')).json()).clearedThrough, through);
  assert.deepEqual(await (await request('/api/activity?limit=500')).json(), []);
  assert.equal(await readFile(join(DATA_DIR, 'activity.jsonl'), 'utf8'), auditBefore);
  assert.equal((await request('/api/activity/view', 'PUT', { through: null })).status, 200);
  assert.deepEqual(await (await request('/api/activity?limit=500')).json(), activityBefore);
  console.log('Dashboard policy enforcement, poll reporting, authenticated APIs and persistence: passed.');
  if (serve) {
    // Fictional content for browser verification, confined to the temporary test home.
    const events = [];
    for (const [index, chat, author, message, action] of [
      [0, 'Release planning', 'Alex Morgan', 'Could you review the deployment checklist before we ship this afternoon?', 'alarm'],
      [1, 'Design team', 'Sam Lee', 'The updated mockups are ready for tomorrow’s review.', 'ignore'],
      [2, 'Project updates', 'Taylor Chen', 'Morning update: the integration checks passed. Nothing blocking the release.', 'ignore'],
      [3, 'Long chat name — engineering and customer support coordination', 'Jordan', '<img src=x onerror=alert(1)> This is untrusted message text.', 'ignore'],
    ]) {
      const start = Date.now() - (index + 1) * 60000;
      for (const [step, stage, fields] of [[0, 'message', { latest: { author, text: message }, historyCount: 12 }], [1, 'policy', { action: 'blocked', reason: 'Empty whitelist: no Teams replies.' }], [2, 'brain_input', { provider: 'gemini', model: 'gemini-3.1-flash-lite', system: 'Alert on direct requests.', user: message }], [3, 'brain_output', { raw: JSON.stringify({ action }) }], [4, 'decision', { action, reason: action === 'alarm' ? 'A direct request needs your attention.' : 'Informational update. No action needed.' }], [5, 'effect', { effect: action === 'alarm' ? 'phone_alert' : 'ignored', status: action === 'alarm' ? 'ok' : 'ignored', reason: action === 'alarm' ? 'Alert accepted by the configured transport.' : 'No notification sent.' }]]) {
        events.push({ kind: 'flow', flowId: 'preview-' + index, chat, stage, at: new Date(start + step * 220).toISOString(), ...fields });
      }
    }
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    await writeFile(join(DATA_DIR, 'activity.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    await request('/api/reply-policy', 'PUT', { mode: 'whitelist', entries: [] });
    console.log('Isolated browser preview: http://127.0.0.1:18091');
    await new Promise(() => {});
  }
} finally { await close(); }
