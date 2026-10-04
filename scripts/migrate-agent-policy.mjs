// Explicit one-time YAML automation conversion. Never loaded by the runtime.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CONFIG_FILE, DATA_DIR } from '../src/local-paths.mjs';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { POLICY_FILE, savePolicy } from '../src/agent/policy.mjs';
import { convertAutomationToPolicy } from './lib/convert-policy.mjs';

export async function migrateAgentPolicy() {
  const config = await loadConfig();
  const changed = Boolean(config.automation) || Object.hasOwn(config.alerts || {}, 'ignoreAuthors') || Object.hasOwn(config.alerts || {}, 'notifyAll');
  if (changed) {
    const backup = CONFIG_FILE + '.automation.bak';
    if (!existsSync(backup)) await writeFile(backup, await readFile(CONFIG_FILE, 'utf8'), { flag: 'wx' });
    // Existing hand-written policy wins; never replace it during trial setup.
    if (config.automation && !existsSync(POLICY_FILE)) await savePolicy(convertAutomationToPolicy(config.automation, config.alerts));
    delete config.automation;
    delete config.alerts?.ignoreAuthors;
    delete config.alerts?.notifyAll;
    await saveConfig(config);
  }
  // Preserve old observations for explicit reads; no runtime legacy decoding path.
  const file = join(DATA_DIR, 'agent', 'store.sqlite');
  let snapshots = 0;
  if (existsSync(file)) {
    const db = new Database(file, { strict: true });
    try {
      db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS reaction_snapshots(id TEXT PRIMARY KEY,body TEXT,observed INTEGER);');
      snapshots = db.query(`INSERT OR IGNORE INTO reaction_snapshots(id,body,observed)
        SELECT id,json_extract(body,'$.reactions'),observed FROM messages
        WHERE CASE WHEN json_valid(body) THEN json_type(body,'$.reactions') END='array'`).run().changes;
    } finally { db.close(); }
  }
  return { migrated: changed, snapshots };
}

if (import.meta.main) console.log(await migrateAgentPolicy());
