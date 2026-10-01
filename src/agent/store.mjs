import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
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
    CREATE TABLE IF NOT EXISTS documents(kind TEXT,path TEXT,text TEXT,PRIMARY KEY(kind,path));
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,body TEXT,summary TEXT);
    CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,kind TEXT,body TEXT,created INTEGER,state TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE INDEX IF NOT EXISTS action_due ON actions(state,due);
    CREATE INDEX IF NOT EXISTS message_chat ON messages(chat,time);`);
  const store = {
    mode(value) {
      if (value !== undefined) {
        if (!['active', 'read_only', 'paused'].includes(value)) throw Error('Invalid autonomy mode');
        db.query('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('mode', value);
      }
      return db.query("SELECT value FROM settings WHERE key='mode'").get()?.value || 'active';
    },
    current(value) {
      if (value !== undefined) db.query('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('current', JSON.stringify(value));
      try { return JSON.parse(db.query("SELECT value FROM settings WHERE key='current'").get()?.value || 'null'); } catch { return null; }
    },
    enqueue(kind, value) {
      if (db.query("SELECT COUNT(*) n FROM work WHERE state='pending'").get().n >= 500) throw Error('Work queue is full');
      const id = randomUUID();
      db.query("INSERT INTO work(id,kind,body,created,state) VALUES(?,?,?,?,'pending')").run(id, kind, JSON.stringify(value), Date.now());
      return { id, state: 'pending' };
    },
    claimWork() {
      return db.transaction(() => {
        const row = db.query("SELECT * FROM work WHERE state='pending' ORDER BY created,rowid LIMIT 1").get();
        if (!row) return null;
        db.query("UPDATE work SET state='processing' WHERE id=?").run(row.id);
        return decode(row);
      }).immediate();
    },
    claimNext() {
      return db.transaction(() => {
        const message = db.query("SELECT time FROM messages WHERE state='pending' ORDER BY time,seq LIMIT 1").get();
        const work = db.query("SELECT created FROM work WHERE state='pending' ORDER BY created,rowid LIMIT 1").get();
        if (work && (!message || work.created < message.time)) return { kind: 'work', row: store.claimWork() };
        return { kind: 'message', row: store.claimMessage() };
      }).immediate();
    },
    finishWork(id, state) { db.query('UPDATE work SET state=? WHERE id=?').run(state, id); },
    note(path, text) {
      if (typeof path !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:md|txt)$/.test(path) || path.length > 200) throw Error('Use a relative .md/.txt note path without dots or traversal');
      if (text !== undefined) {
        if (typeof text !== 'string' || text.length > 32000) throw Error('Note exceeds 32000 characters');
        if (!store.notes().some(n => n.path === path) && store.notes().length >= 200) throw Error('Maximum 200 notes');
        db.query('INSERT OR REPLACE INTO documents(kind,path,text) VALUES(?,?,?)').run('note', path, text);
      }
      return { path, text: db.query("SELECT text FROM documents WHERE kind='note' AND path=?").get(path)?.text || '' };
    },
    notes() { return db.query("SELECT path,text FROM documents WHERE kind='note' ORDER BY path").all(); },
    brief(chat, text) {
      if (typeof chat !== 'string' || !chat.trim() || chat.length > 300) throw Error('Invalid exact chat name');
      if (text !== undefined) {
        if (typeof text !== 'string' || text.length > 16000) throw Error('Brief exceeds 16000 characters');
        db.query('INSERT OR REPLACE INTO documents(kind,path,text) VALUES(?,?,?)').run('brief', normalize(chat), text);
      }
      return { chat, text: db.query("SELECT text FROM documents WHERE kind='brief' AND path=?").get(normalize(chat))?.text || '' };
    },
    session(id, value) {
      if (typeof id !== 'string' || !id || id.length > 300) throw Error('Invalid context ID');
      if (value !== undefined) db.query('INSERT OR REPLACE INTO sessions(id,body,summary) VALUES(?,?,?)').run(id, JSON.stringify(value), value.summary || '');
      const row = db.query('SELECT * FROM sessions WHERE id=?').get(id);
      try {
        const value = row ? JSON.parse(row.body) : { history: [], summary: '' };
        if (!Array.isArray(value.history)) throw Error();
        return value;
      }
      catch { return { history: [], summary: 'Invalid stored history; original run records remain available.' }; }
    },
    commit(runId, plan, messageId, workId) {
      db.transaction(() => {
        if (plan.modelWrites && store.mode() !== 'active') throw Error('Agent autonomy changed before commit; no effects committed');
        store.plan(messageId || runId, plan.actions || []);
        for (const id of plan.cancellations || []) if (!store.cancel(id)) throw Error('Action is no longer pending; no plan committed');
        for (const [id, edit] of Object.entries(plan.modifications || {})) {
          const changed = db.query("UPDATE actions SET body=? WHERE id=? AND state='pending' AND body=?").run(JSON.stringify(edit.action), id, edit.expectedBody).changes;
          if (!changed) throw Error('Action changed or execution began; no plan committed');
        }
        for (const [path, text] of Object.entries(plan.notes || {})) store.note(path, text);
        for (const [id, session] of Object.entries(plan.sessions || {})) store.session(id, session);
        store.record(runId, 'policy_result', { ...plan, sessions: Object.keys(plan.sessions || {}) });
        if (messageId) store.finishMessage(messageId);
        if (workId) store.finishWork(workId, 'handled');
      }).immediate();
      store.mirrorNotes();
    },
    mirrorNotes() {
      // SQLite is the transactional source; Markdown mirrors are recoverable after a crash.
      if (file === ':memory:') return;
      try {
        const root = join(dirname(file), 'notes'); mkdirSync(root, { recursive: true });
        if (realpathSync(root).toLowerCase() !== root.toLowerCase()) return;
        for (const note of store.notes()) {
          store.note(note.path);
          const target = join(root, note.path), directory = dirname(target);
          mkdirSync(directory, { recursive: true });
          if (realpathSync(directory).toLowerCase() !== directory.toLowerCase()) continue;
          const temp = target + '.' + randomUUID() + '.tmp';
          writeFileSync(temp, note.text, { flag: 'wx' }); renameSync(temp, target);
        }
      } catch { /* The committed notes remain available in SQLite. */ }
    },
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
    history(chat, limit = 50) { return db.query('SELECT * FROM messages WHERE lower(chat)=lower(?) ORDER BY time DESC,seq DESC LIMIT ?').all(chat, Math.max(1, Math.min(200, limit))).reverse().map(decode); },
    search(query, chat = null) { return db.query('SELECT * FROM messages WHERE (? IS NULL OR chat=?) AND instr(lower(body),lower(?))>0 ORDER BY time DESC LIMIT 100').all(chat, chat, query).map(decode); },
    record(runId, kind, value) { db.query('INSERT INTO records(runId,kind,body,at) VALUES(?,?,?,?)').run(runId, kind, JSON.stringify(value), Date.now()); },
    records(limit = 100) { return db.query('SELECT * FROM records ORDER BY seq DESC LIMIT ?').all(Math.min(limit, 500)).map(decode); },
    plan(runId, actions) {
      db.transaction(() => {
        if (db.query("SELECT COUNT(*) n FROM actions WHERE state='pending'").get().n + actions.length > 500) throw Error('Pending action limit reached');
        for (const action of actions) db.query('INSERT INTO actions(id,body,runId,due,created,state) VALUES(?,?,?,?,?,?)').run(action.id || randomUUID(), JSON.stringify(action), runId, action.due || Date.now(), Date.now(), action.cancelled ? 'cancelled' : 'pending');
      }).immediate();
    },
    actions() { return [...db.query("SELECT * FROM actions WHERE state IN ('pending','running') ORDER BY due,created").all(),
      ...db.query("SELECT * FROM actions WHERE state NOT IN ('pending','running') ORDER BY created DESC LIMIT 100").all()].map(decode); },
    cancel(id) { return db.query("UPDATE actions SET state='cancelled' WHERE id=? AND state='pending'").run(id).changes === 1; },
    action(id) { return decode(db.query('SELECT * FROM actions WHERE id=?').get(id)); },
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
        db.query("UPDATE work SET state='uncertain' WHERE state='processing'").run();
        db.query("DELETE FROM settings WHERE key='current'").run();
        db.query("UPDATE messages SET state='observed' WHERE state='pending' AND time<?").run(Date.parse(activatedAt));
        db.query("UPDATE actions SET state='uncertain',result=? WHERE state='running'").run(JSON.stringify({ error: 'Interrupted attempt; no automatic retry.' }));
        db.query("UPDATE actions SET state='missed' WHERE state='pending' AND due<? AND COALESCE(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END,'invalid')!='wake'").run(Date.parse(activatedAt));
      }).immediate();
    },
    close() { db.close(); },
  };
  return store;
}
