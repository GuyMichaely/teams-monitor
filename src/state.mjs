// Persistent state + activity log.
//
// Purpose is REVIEW/AUDIT, not loop control:
//  - Per chat, we record the first message Claude read on your behalf ("catch-up
//    marker") so you know where to resume reading yourself.
//  - Every decision/action is appended to an activity log you can replay.
//
// Intentionally does NOT suppress re-processing — the orchestrator is allowed to
// loop (see README / echoLoop).

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const STATE_FILE = join(DATA_DIR, "state.json");
const ACTIVITY_LOG = join(DATA_DIR, "activity.jsonl");

async function ensureDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

export async function loadState() {
  await ensureDir();
  if (!existsSync(STATE_FILE)) return { chats: {} };
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { chats: {} };
  }
}

export async function saveState(state) {
  await ensureDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Record, once per chat, the first message Claude handled on the user's behalf.
 * This is the point the user should resume reading from to catch up.
 */
export async function markFirstRead(state, chatName, message) {
  const entry = (state.chats[chatName] ||= {});
  if (!entry.firstReadByClaude) {
    entry.firstReadByClaude = {
      time: message?.time || null,
      author: message?.author || null,
      text: message?.text || null,
      recordedAt: new Date().toISOString(),
    };
  }
  entry.lastSeen = {
    time: message?.time || null,
    author: message?.author || null,
    text: message?.text || null,
    at: new Date().toISOString(),
  };
  return state;
}

/** Append one line to the activity log (JSONL). */
export async function logActivity(record) {
  await ensureDir();
  await appendFile(ACTIVITY_LOG, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

export { DATA_DIR, STATE_FILE, ACTIVITY_LOG };
