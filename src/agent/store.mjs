import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_DIR } from '../local-paths.mjs';

export const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const messageKey = (chat, message) => createHash('sha256').update(JSON.stringify([normalize(chat), message.reaction ? message : message.id || [message.time, message.author, message.text]])).digest('hex');
const decode = row => {
  if (!row) return null;
  try { return { ...row, value: JSON.parse(row.body) }; } catch { return { ...row, state: 'invalid', value: null }; }
};

export function agentStore(file = join(DATA_DIR, 'agent', 'store.sqlite')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,chat TEXT,body TEXT,time INTEGER,observed INTEGER,state TEXT);
    CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,body TEXT,runId TEXT,due INTEGER,created INTEGER,state TEXT,attempt TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT,kind TEXT,body TEXT,at INTEGER);
    CREATE INDEX IF NOT EXISTS action_due ON actions(state,due);
    CREATE INDEX IF NOT EXISTS message_chat ON messages(chat,time);`);
  const store = {
    completeMessage(id, runId, actions, result) {
      db.transaction(() => { store.plan(id, actions); store.record(runId, 'policy_result', result); store.finishMessage(id); }).immediate();
    },
    observe(chat, message, eligible = false) {
      const id = messageKey(chat, message), now = Date.now();
      const changed = db.query('INSERT OR IGNORE INTO messages(id,chat,body,time,observed,state) VALUES(?,?,?,?,?,?)').run(id, chat, JSON.stringify(message), Date.parse(message.time) || now, now, eligible ? 'pending' : 'observed').changes;
      return changed && eligible ? id : null;
    },
    claimMessage() {
      return db.transaction(() => {
        const row = db.query("SELECT * FROM messages WHERE state='pending' ORDER BY time,seq LIMIT 1").get();
        if (!row) return null;
        db.query("UPDATE messages SET state='processing' WHERE id=?").run(row.id);
        return decode(row);
      }).immediate();
    },
    finishMessage(id, state = 'handled') { db.query('UPDATE messages SET state=? WHERE id=?').run(state, id); },
    message(id) { return decode(db.query('SELECT * FROM messages WHERE id=?').get(id)); },
    conversations() {
      return db.query('SELECT chat,COUNT(*) count,MIN(time) first,MAX(time) last FROM messages GROUP BY chat ORDER BY last DESC').all().map(row => ({ ...row, coverage: 'Observed visible tails only; not a complete Teams archive.' }));
    },
    history(chat, limit = 50) { return db.query('SELECT * FROM messages WHERE chat=? ORDER BY time DESC,seq DESC LIMIT ?').all(chat, Math.min(200, limit)).reverse().map(decode); },
    search(query, chat = null) { return db.query('SELECT * FROM messages WHERE (? IS NULL OR chat=?) AND instr(lower(body),lower(?))>0 ORDER BY time DESC LIMIT 100').all(chat, chat, query).map(decode); },
    record(runId, kind, value) { db.query('INSERT INTO records(runId,kind,body,at) VALUES(?,?,?,?)').run(runId, kind, JSON.stringify(value), Date.now()); },
    records(limit = 100) { return db.query('SELECT * FROM records ORDER BY seq DESC LIMIT ?').all(Math.min(limit, 500)).map(decode); },
    plan(runId, actions) {
      db.transaction(() => {
        if (db.query("SELECT COUNT(*) n FROM actions WHERE state='pending'").get().n + actions.length > 500) throw Error('Pending action limit reached');
        for (const action of actions) db.query('INSERT INTO actions(id,body,runId,due,created,state) VALUES(?,?,?,?,?,?)').run(action.id || randomUUID(), JSON.stringify(action), runId, action.due || Date.now(), Date.now(), action.cancelled ? 'cancelled' : 'pending');
      }).immediate();
    },
    actions() { return db.query('SELECT * FROM actions ORDER BY created DESC LIMIT 200').all().map(decode); },
    cancel(id) { return db.query("UPDATE actions SET state='cancelled' WHERE id=? AND state='pending'").run(id).changes === 1; },
    claimAction(now = Date.now()) {
      return db.transaction(() => {
        const row = db.query("SELECT * FROM actions WHERE state='pending' AND due<=? ORDER BY due,created LIMIT 1").get(now);
        if (!row) return null;
        const attempt = randomUUID();
        db.query("UPDATE actions SET state='running',attempt=? WHERE id=?").run(attempt, row.id);
        return { ...decode(row), attempt };
      }).immediate();
    },
    finishAction(id, attempt, state, result) { db.query("UPDATE actions SET state=?,result=? WHERE id=? AND attempt=? AND state='running'").run(state, JSON.stringify(result), id, attempt); },
    recover(activatedAt) {
      db.transaction(() => {
        db.query("UPDATE messages SET state='uncertain' WHERE state='processing'").run();
        db.query("UPDATE messages SET state='observed' WHERE state='pending' AND time<?").run(Date.parse(activatedAt));
        db.query("UPDATE actions SET state='uncertain',result=? WHERE state='running'").run(JSON.stringify({ error: 'Interrupted attempt; no automatic retry.' }));
        db.query("UPDATE actions SET state='missed' WHERE state='pending' AND due<? AND COALESCE(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END,'invalid')!='wake'").run(Date.parse(activatedAt));
      }).immediate();
    },
    close() { db.close(); },
  };
  return store;
}
