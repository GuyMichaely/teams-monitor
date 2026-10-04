import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./local-paths.mjs";

const FILE = join(DATA_DIR, "poll.json");
export async function readPoll() {
  try { return JSON.parse(await readFile(FILE, "utf8")); }
  catch { return null; }
}

export function createPoll(intervalMs) {
  const state = {
    id: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(),
    completedAt: null, nextPollAt: null, status: "scanning", stage: "Finding unread chats",
    currentChat: null, targets: 0, unreadChats: null, unreadCheckedAt: null, unreadFound: 0,
    reactionChecks: 0, examined: 0, handled: 0, duplicates: 0, errors: 0,
  };
  async function update(fields = {}) {
    Object.assign(state, fields, { updatedAt: new Date().toISOString() });
    try {
      await mkdir(DATA_DIR, { recursive: true });
      const temp = FILE + "." + process.pid + ".tmp";
      await writeFile(temp, JSON.stringify(state) + "\n");
      await rename(temp, FILE);
    } catch { /* Observability must not stop monitoring. */ }
  }
  return { state, update, async finish(error) {
    await update({ status: error ? "error" : "completed", stage: error ? "Poll failed" : "Poll complete",
      error: error?.message || null, currentChat: null, completedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(state.startedAt), nextPollAt: new Date(Date.now() + intervalMs).toISOString() });
  } };
}
