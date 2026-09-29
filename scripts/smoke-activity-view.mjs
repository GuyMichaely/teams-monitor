import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { activityView, clearActivityThrough, restoreActivity, visibleActivity } from "../src/activity-view.mjs";
import { ACTIVITY_LOG } from "../src/state.mjs";

const old = "2026-01-01T10:00:00.000Z", cutoff = "2026-01-01T11:00:00.000Z", newer = "2026-01-01T12:00:00.000Z";
const records = [
  { at: old, kind: "decision", latest: {} },
  { at: cutoff, flowId: "old", stage: "message", latest: {} },
  { at: newer, flowId: "old", stage: "effect" },
  { at: newer, flowId: "new", stage: "message", latest: {} },
  { at: newer, flowId: "truncatedOld", flowStartedAt: old, kind: "decision", latest: {} },
  { at: newer, flowId: "orphan", stage: "effect" },
  { at: newer, kind: "poll_error" },
];
const source = records.map(r => JSON.stringify(r)).join("\n");
await writeFile(ACTIVITY_LOG, source);
assert.equal(activityView().clearedThrough, null);
assert.deepEqual(visibleActivity(records), records);
clearActivityThrough(cutoff);
assert.equal(activityView().clearedThrough, cutoff);
assert.deepEqual(visibleActivity(records), [records[3], records[6]], "Clear whole flows, including later handling stages; preserve newer events");
clearActivityThrough(old);
assert.equal(activityView().clearedThrough, old, "The date filter can move backwards as well as forwards");
for (const invalid of [null, {}, "", "invalid", "2026-01-01", "2026-02-30T00:00:00.000Z"]) assert.throws(() => clearActivityThrough(invalid), { httpCode: 400 });
assert.equal(await readFile(ACTIVITY_LOG, "utf8"), source, "Audit file must never be rewritten or truncated");
restoreActivity();
assert.deepEqual(visibleActivity(records), records);
console.log("Persistent activity clearing, inclusive cutoff, late-stage filtering, restore and audit preservation passed.");
