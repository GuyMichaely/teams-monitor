// Clear the dashboard without rewriting an audit file another process is appending to.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./local-paths.mjs";

const FILE = join(DATA_DIR, "activity-view.json");
export function activityView() {
  try {
    const view = JSON.parse(readFileSync(FILE, "utf8"));
    if (view?.clearedThrough === null || validDate(view?.clearedThrough)) return { clearedThrough: view.clearedThrough };
    return { clearedThrough: null, warning: "Invalid activity filter format; showing retained activity" };
  } catch (e) {
    if (e.code === "ENOENT") return { clearedThrough: null };
    if (e instanceof SyntaxError) return { clearedThrough: null, warning: "Invalid activity filter format; showing retained activity" };
    throw e;
  }
}

function validDate(value) { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function clearActivityThrough(through) {
  if (!validDate(through)) throw Object.assign(new Error("through must be a valid UTC timestamp"), { httpCode: 400 });
  return save({ clearedThrough: through });
}
export function restoreActivity() { return save({ clearedThrough: null }); }
function save(view) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify(view) + "\n");
  renameSync(FILE + ".tmp", FILE);
  return view;
}

export function visibleActivity(records, { clearedThrough } = activityView()) {
  if (!clearedThrough) return records;
  const cutoff = Date.parse(clearedThrough);
  const starts = new Map();
  for (const r of records) {
    if (!r || typeof r !== "object" || !r.flowId) continue;
    const start = Date.parse(r.flowStartedAt || r.at);
    starts.set(r.flowId, Math.min(starts.get(r.flowId) ?? Infinity, start));
  }
  // With a truncated tail, a flow without its opening message is incomplete;
  // don't resurrect its late stages after the user cleared it.
  const known = new Set(records.filter(r => r && (r.flowStartedAt || r.stage === "message")).map(r => r.flowId));
  return records.filter(r => {
    if (!r || typeof r !== "object") return true; // Let the UI identify malformed records.
    if (r.kind === "invalid_log" || !Number.isFinite(Date.parse(r.at))) return true;
    if (!r.flowId) return Date.parse(r.at) > cutoff;
    return known.has(r.flowId) && starts.get(r.flowId) > cutoff;
  });
}
