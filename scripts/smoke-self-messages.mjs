import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { processChat, tick } from "../src/orchestrator.mjs";
import { ACTIVITY_LOG } from "../src/state.mjs";
import { readPoll } from "../src/poll-status.mjs";
import { registerAction } from "../src/actions.mjs";

let decisions = 0, alerts = 0, sends = 0;
registerAction({ name: "alert_phone", run: async () => { alerts++; } });
const config = { alerts: { mentionNames: ["Guy Michaely", "Guy"] }, automation: { rules: [{ id: 'direct', when: { type: 'direct_message' }, action: { type: 'alert_phone' } }] } };
const self = { author: "Guy Michaely", time: "2026-09-23T21:14:37.130Z", text: "Edited outgoing message" };
const incoming = { author: "Joseph Lynch", time: "2026-09-23T21:14:35.000Z", text: "A question for you" };
const brain = { reviewPlan: async () => { decisions++; return { changes: [], additions: [], reason: "test" }; } };
const io = { getUnreadChats: async () => ["Joseph Lynch"], readChat: async () => ({ messages: [self] }), sendMessage: async () => { sends++; } };
for (const variant of [config, { ...config, alerts: { ...config.alerts, notifyAll: true } }, { ...config, replyPolicy: { mode: "blacklist", entries: [] } }]) {
  assert.equal(await processChat({ chat: "Joseph Lynch", config: variant, brain, state: { chats: {} }, io }), "self");
}
await tick({ config, brain, io });
assert.equal((await readPoll()).skipped, 1);
assert.equal((await readPoll()).handled, 0);
assert.equal(decisions, 0); assert.equal(alerts, 0); assert.equal(sends, 0);

const state = { chats: {} };
const mixedIo = { ...io, readChat: async () => ({ messages: [incoming, self] }) };
await processChat({ chat: "Joseph Lynch", config, brain, state, io: mixedIo });
assert.equal(decisions, 0, "Direct incoming message bypasses the LLM"); assert.equal(alerts, 1, "Outgoing edit must not mask an incoming message");
assert.equal(await processChat({ chat: "Joseph Lynch", config, brain, state, io: mixedIo }), "duplicate");
const editedIo = { ...io, readChat: async () => ({ messages: [incoming, { ...self, text: "Edited again", time: "2026-09-23T21:15:00.000Z" }] }) };
assert.equal(await processChat({ chat: "Joseph Lynch", config, brain, state, io: editedIo }), "duplicate");
assert.equal(decisions, 0); assert.equal(alerts, 1);
const oldState = { chats: { "Joseph Lynch": { lastSeen: self } } };
assert.equal(await processChat({ chat: "Joseph Lynch", config, brain, state: oldState, io: mixedIo }), "duplicate", "Migration must not replay incoming messages older than an already seen outgoing edit");
await processChat({ chat: "Guy Michaely (You)", config: { ...config, alerts: { ...config.alerts, notifyAll: true } }, brain, state: { chats: {} }, io });
assert.equal(alerts, 2, "Self-chat remains usable as a test harness");
await processChat({ chat: "Joseph Lynch", config: { ...config, alerts: { ...config.alerts, notifyAll: true } }, echoLoop: true, brain, state: { chats: {} }, io });
assert.equal(alerts, 3, "Explicit echo debug mode is preserved");
const records = (await readFile(ACTIVITY_LOG, "utf8")).trim().split("\n").map(JSON.parse);
assert(!records.some(r => r.kind === "flow" && r.stage === "message" && r.chat === "Joseph Lynch" && r.latest.text === self.text && !r.flowStartedAt));
console.log("Own-message/edit filtering, mixed incoming history, dedupe migration and self-chat testing passed.");
