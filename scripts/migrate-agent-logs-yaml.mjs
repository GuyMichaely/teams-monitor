import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DATA_DIR } from '../src/local-paths.mjs';
import { yamlLogValue } from '../src/yaml-log.mjs';

// Explicit offline migration, never imported by application runtime.
export function migrateAgentLogRecords(file = join(DATA_DIR, 'agent', 'store.sqlite')) {
  if (!existsSync(file)) return { records: 0, skipped: true };
  const db = new Database(file, { strict: true });
  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get()) return { records: 0, skipped: true };
    if (db.query("SELECT value FROM settings WHERE key='recordFormat'").get()?.value === 'yaml-v1') return { records: 0, skipped: true };
    const backup = file + '.pre-yaml.bak';
    if (!existsSync(backup)) db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
    let invalid = 0;
    const records = db.query('SELECT seq,runId,kind,body FROM records ORDER BY seq').all().map(row => {
      let value;
      try { value = JSON.parse(row.body); }
      catch { value = { invalidLog: true, error: 'Invalid log format', raw: row.body }; invalid++; }
      const yaml = Bun.YAML.stringify(yamlLogValue(value), null, 2);
      assert.deepEqual(Bun.YAML.parse(yaml), value, 'YAML record verification failed');
      return { ...row, value, yaml };
    });
    db.transaction(() => {
      db.exec('DROP INDEX IF EXISTS record_message; DROP INDEX IF EXISTS record_policy_model;');
      const columns = db.query('PRAGMA table_info(records)').all().map(row => row.name);
      for (const name of ['messageId', 'policyRunId', 'conversationId']) if (!columns.includes(name)) db.exec(`ALTER TABLE records ADD COLUMN ${name} TEXT`);
      const link = value => typeof value === 'string' ? value : null;
      for (const row of records) db.query('UPDATE records SET body=?,messageId=?,policyRunId=?,conversationId=? WHERE seq=?')
        .run(row.yaml, link(row.value?.context?.messageId), link(row.value?.policyRunId), link(row.value?.conversationId), row.seq);
      db.exec(`CREATE INDEX record_message ON records(messageId,seq) WHERE kind='policy_input';
        CREATE INDEX record_policy_model ON records(policyRunId,runId) WHERE kind IN ('agent_input','agent_result');
        CREATE INDEX IF NOT EXISTS record_conversation ON records(conversationId,seq) WHERE kind='conversation_reset';
        CREATE TABLE IF NOT EXISTS action_sources(actionId TEXT PRIMARY KEY,messageId TEXT);
        CREATE INDEX IF NOT EXISTS action_source_message ON action_sources(messageId);
        INSERT OR IGNORE INTO action_sources(actionId,messageId) SELECT a.id,m.id FROM actions a JOIN messages m ON m.id=a.runId;`);
      // Follow recorded action-result/wake parentage without changing action state.
      const continuations = records.filter(row => row.kind === 'policy_input' && (row.value?.context?.actionId || row.value?.context?.outcome?.id));
      for (let pass = 0; pass < continuations.length; pass++) {
        let changed = 0;
        for (const row of continuations) {
          const parent = row.value.context.actionId || row.value.context.outcome.id;
          const source = db.query('SELECT messageId FROM action_sources WHERE actionId=?').get(parent)?.messageId;
          if (source) changed += db.query('INSERT OR IGNORE INTO action_sources(actionId,messageId) SELECT id,? FROM actions WHERE runId=?').run(source, row.runId).changes;
        }
        if (!changed) break;
      }
      db.query('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('recordFormat', 'yaml-v1');
      assert.equal(db.query('SELECT COUNT(*) n FROM records').get().n, records.length);
    }).immediate();
    return { records: records.length, invalid, backup };
  } finally { db.close(); }
}
