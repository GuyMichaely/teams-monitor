// Clear the dashboard without rewriting an audit file another process is appending to.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./local-paths.mjs";
import { filterActivityAfter } from './activity-filter.mjs';

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
  return filterActivityAfter(records, clearedThrough);
}
