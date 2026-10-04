import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/local-paths.mjs';
import { agentStore } from '../src/agent/store.mjs';
import { agentAPI } from '../src/agent/api.mjs';
import { migrateAgentLogRecords } from './migrate-agent-logs-yaml.mjs';
import { logYaml } from '../src/dashboard-yaml.mjs';

const file = join(DATA_DIR, 'old-agent.sqlite');
const db = new Database(file);
db.exec(`CREATE TABLE records(seq INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT,kind TEXT,body TEXT,at INTEGER);
 CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE actions(id TEXT PRIMARY KEY,body TEXT,runId TEXT,due INTEGER,created INTEGER,state TEXT,attempt TEXT,result TEXT);
 CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,chat TEXT,body TEXT,time INTEGER,observed INTEGER,state TEXT);
 CREATE INDEX record_message ON records(json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END,'$.context.messageId')) WHERE kind='policy_input';`);
const values = [
  { context: { messageId: 'origin', trigger: 'message' }, source: 'const example = "---\\n";', handler: 'handle' },
  { policyRunId: 'policy', conversationId: 'chosen', input: { lines: 'line1\n---\nline2', value: '2026-10-04', nil: null } },
  { conversationId: 'chosen', previous: { history: [{ role: 'user', content: 'kept' }] } },
];
for (let i = 0; i < values.length; i++) db.query('INSERT INTO records(runId,kind,body,at) VALUES(?,?,?,?)')
  .run(i === 1 ? 'model' : 'policy', ['policy_input', 'agent_input', 'conversation_reset'][i], JSON.stringify(values[i]), 100 + i);
db.query('INSERT INTO records(runId,kind,body,at) VALUES(?,?,?,?)').run('bad', 'broken', '{bad', 104);
db.query('INSERT INTO messages(id,chat,body,time,observed,state) VALUES(?,?,?,?,?,?)').run('origin', 'Fixture', '{}', 1, 1, 'handled');
db.query('INSERT INTO actions(id,body,runId,due,created,state) VALUES(?,?,?,?,?,?)').run('first', '{"kind":"wake","prompt":"later"}', 'origin', 1, 1, 'completed');
db.close();
assert.throws(() => agentStore(file), /migrate-logs-yaml/);
const migration = migrateAgentLogRecords(file);
assert.equal(migration.records, 4); assert.equal(migration.invalid, 1); assert(existsSync(migration.backup));
assert(migrateAgentLogRecords(file).skipped);
const store = agentStore(file);
try {
  const records = store.records();
  assert.equal(records[0].state, 'invalid');
  assert.deepEqual(records.find(row => row.kind === 'agent_input').value, values[1]);
  assert(!records.find(row => row.kind === 'agent_input').body.startsWith('{'));
  assert.equal(store.messageRuns('origin')[0].models[0].runId, 'model');
  assert.deepEqual(store.sessionArchives('chosen')[0].value.previous.history, values[2].previous.history);
  assert.equal(store.action('first').messageId, 'origin');
  const queued = store.enqueue('wake', { actionId: 'first' });
  store.commit('continuation', { actions: [{ id: 'child', kind: 'alert', title: 'Fixture', body: 'Only a fixture', due: Date.now() + 60000 }] }, null, queued.id);
  assert.equal(store.action('child').messageId, 'origin');
  assert.deepEqual(new Set(store.messageActions('origin').map(row => row.id)), new Set(['first', 'child']));
  store.plan('unrelated', [{ id: 'other', kind: 'status', status: 'away' }]);
  const reply = await agentAPI({ url: new URL('http://local/api/agent/invocations?messageId=origin'), method: 'GET', body: {}, store });
  assert.equal(reply.actions.length, 2);
  assert(!reply.actions.some(row => row.id === 'other'));
  assert(!('body' in reply.actions[0]), 'API omits internal JSON storage text');
  assert(store.cancel('child'));
  assert.equal(store.messageActions('origin').find(row => row.id === 'child').state, 'cancelled');
} finally { store.close(); }
for (const value of [{ foo: 'true', quoted: '2026-10-04', values: [true, false, null, 'yes', {}, []] }, [{ prompt: 'multiple\nlines\n', 'weird: key': '---' }]])
  assert.deepEqual(Bun.YAML.parse(logYaml(value)), value);
console.log('Agent YAML logs: offline migration, invalid records, indexed invocation/history lookup, preserved action state/source links, descendant actions and YAML UI formatting passed.');
