import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_DIR } from '../local-paths.mjs';
import { conversationId } from './conversations.mjs';
import { AgentRuntimeError } from './errors.mjs';
import { publicBadges } from './message-view.mjs';
import { yamlLogValue } from '../yaml-log.mjs';

export const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const messageKey = (chat, message) => createHash('sha256').update(JSON.stringify([normalize(chat), message.reaction ? message : message.id || [message.time, message.author, message.text]])).digest('hex');
const decode = row => {
  if (!row) return null;
  try { return { ...row, value: JSON.parse(row.body) }; } catch { return { ...row, state: 'invalid', value: null }; }
};
const decodeRecord = row => {
  try {
    const value = Bun.YAML.parse(row.body);
    if (value?.invalidLog === true) throw Error();
    return { ...row, value };
  } catch { return { ...row, state: 'invalid', value: null }; }
};

export function agentStore(file = join(DATA_DIR, 'agent', 'store.sqlite')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  const oldRecords = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get();
  if (oldRecords) {
    let format;
    try { format = db.query("SELECT value FROM settings WHERE key='recordFormat'").get()?.value; } catch {}
    if (format !== 'yaml-v1') { db.close(); throw Error('Run bun scripts/migrate-logs-yaml.mjs with the system stopped before opening existing agent logs.'); }
  }
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,chat TEXT,body TEXT,time INTEGER,observed INTEGER,state TEXT);
    CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,body TEXT,runId TEXT,due INTEGER,created INTEGER,state TEXT,attempt TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT,kind TEXT,body TEXT,at INTEGER,messageId TEXT,policyRunId TEXT,conversationId TEXT);
    CREATE TABLE IF NOT EXISTS action_sources(actionId TEXT PRIMARY KEY,messageId TEXT);
    CREATE TABLE IF NOT EXISTS documents(kind TEXT,path TEXT,text TEXT,PRIMARY KEY(kind,path));
    CREATE TABLE IF NOT EXISTS person_notes(normalized TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_memberships(normalized TEXT NOT NULL,chat TEXT NOT NULL,source TEXT NOT NULL,members TEXT NOT NULL,PRIMARY KEY(normalized,source));
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,body TEXT,summary TEXT);
    CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,kind TEXT,body TEXT,created INTEGER,state TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS reaction_snapshots(id TEXT PRIMARY KEY,body TEXT,observed INTEGER);
    CREATE INDEX IF NOT EXISTS action_due ON actions(state,due);
    CREATE INDEX IF NOT EXISTS record_run ON records(runId,seq);
    CREATE INDEX IF NOT EXISTS record_kind ON records(kind,seq);
    CREATE INDEX IF NOT EXISTS record_message ON records(messageId,seq) WHERE kind='policy_input';
    CREATE INDEX IF NOT EXISTS record_policy_model ON records(policyRunId,runId) WHERE kind IN ('agent_input','agent_result');
    CREATE INDEX IF NOT EXISTS record_conversation ON records(conversationId,seq) WHERE kind='conversation_reset';
    CREATE INDEX IF NOT EXISTS action_source_message ON action_sources(messageId);
    CREATE INDEX IF NOT EXISTS message_chat ON messages(chat,time);`);
  if (!oldRecords) db.query('INSERT INTO settings(key,value) VALUES(?,?)').run('recordFormat', 'yaml-v1');
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
    cancelRun(runId) {
      if (store.current()?.runId !== runId) throw Error('Run is no longer active');
      db.query('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('cancelRun', runId);
      store.record(runId, 'cancel_requested', { runId });
    },
    runCancelled(runId) { return db.query("SELECT value FROM settings WHERE key='cancelRun'").get()?.value === runId; },
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
    personNote(name, note) {
      if (typeof name !== 'string' || !name.trim() || name.length > 200) throw Error('Invalid person name');
      const displayName = name.trim(), key = normalize(displayName);
      if (note !== undefined) {
        if (typeof note !== 'string' || note.length > 16000) throw Error('Person note exceeds 16000 characters');
        if (note.trim().length) db.query('INSERT OR REPLACE INTO person_notes(normalized,name,note) VALUES(?,?,?)').run(key, displayName, note);
        else db.query('DELETE FROM person_notes WHERE normalized=?').run(key);
      }
      return db.query('SELECT name,note FROM person_notes WHERE normalized=?').get(key) || { name: displayName, note: '' };
    },
    personNotes() { return db.query('SELECT name,note FROM person_notes ORDER BY normalized').all(); },
    chatMembers(chat, members) {
      if (typeof chat !== 'string' || !chat.trim() || chat.length > 300) throw Error('Invalid exact chat name');
      const displayChat = chat.trim(), key = normalize(displayChat);
      if (members !== undefined) {
        if (!Array.isArray(members) || members.length > 100 || members.some(name => typeof name !== 'string' || !name.trim() || name.length > 200)) throw Error('Invalid chat membership');
        const unique = [], seen = new Set();
        for (const raw of members) { const name = raw.trim(), normalized = normalize(name); if (!seen.has(normalized)) { seen.add(normalized); unique.push(name); } }
        db.query('INSERT OR REPLACE INTO chat_memberships(normalized,chat,source,members) VALUES(?,?,?,?)').run(key, displayChat, 'manual', JSON.stringify(unique));
      }
      const rows = db.query('SELECT chat,members,source FROM chat_memberships WHERE normalized=? ORDER BY source').all(key);
      if (!rows.length) return { chat: displayChat, members: [], source: 'unavailable' };
      const merged = [], seen = new Set();
      for (const row of rows) {
        let values; try { values = JSON.parse(row.members); } catch { continue; }
        if (!Array.isArray(values)) continue;
        values = values.filter(name => typeof name === 'string' && name.trim() && name.length <= 200);
        for (const name of values) { const normalized = normalize(name); if (!seen.has(normalized)) { seen.add(normalized); merged.push(name); } }
      }
      return { chat: rows[0].chat, members: merged, source: rows.map(row => row.source).join('+') };
    },
    chatMemberships() {
      return db.query('SELECT chat FROM chat_memberships GROUP BY normalized ORDER BY normalized').all().map(row => store.chatMembers(row.chat));
    },
    brief(chat, text) {
      if (typeof chat !== 'string' || !chat.trim() || chat.length > 300) throw Error('Invalid exact chat name');
      if (text !== undefined) {
        if (typeof text !== 'string' || text.length > 16000) throw Error('Brief exceeds 16000 characters');
        db.query('INSERT OR REPLACE INTO documents(kind,path,text) VALUES(?,?,?)').run('brief', normalize(chat), text);
      }
      return { chat, text: db.query("SELECT text FROM documents WHERE kind='brief' AND path=?").get(normalize(chat))?.text || '' };
    },
    session(id, value) {
      if (!conversationId(id)) throw Error('Conversation ID is required');
      if (value !== undefined) {
        const previous = store.session(id);
        const next = { ...value, revision: previous.revision + 1, epoch: previous.epoch, updatedAt: new Date().toISOString() };
        delete next.expectedRevision;
        db.query('INSERT OR REPLACE INTO sessions(id,body,summary) VALUES(?,?,?)').run(id, JSON.stringify(next), next.summary || '');
      }
      const row = db.query('SELECT * FROM sessions WHERE id=?').get(id);
      try {
        const value = row ? JSON.parse(row.body) : { history: [], summary: '' };
        if (!Array.isArray(value.history)) throw Error();
        return { ...value, exists: !!row, revision: Number.isSafeInteger(value.revision) ? value.revision : 0, epoch: Number.isSafeInteger(value.epoch) ? value.epoch : 0 };
      }
      catch { return { exists: true, invalid: true, revision: 0, epoch: 0, history: [], summary: '' }; }
    },
    sessions() {
      return db.query('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 200').all().map(({ id }) => {
        const s = store.session(id);
        return { id, updatedAt: s.updatedAt, revision: s.revision, epoch: s.epoch, invalid: s.invalid || false,
          turns: s.turns || 0, output: String(s.output || '').slice(0, 1600), chat: s.chatName || null };
      });
    },
    resetSession(id) {
      return db.transaction(() => {
        const previous = store.session(id);
        if (!previous.exists) throw Error('Conversation not found');
        store.record('manual', 'conversation_reset', { conversationId: id, previous });
        const next = { ...previous, history: [], summary: '', output: '', turns: 0, epoch: previous.epoch + 1,
          revision: previous.revision + 1, updatedAt: new Date().toISOString() };
        delete next.invalid;
        db.query('UPDATE sessions SET body=?,summary=? WHERE id=?').run(JSON.stringify(next), '', id);
        return { id, epoch: next.epoch, revision: next.revision };
      }).immediate();
    },
    sessionArchives(id) {
      return db.query("SELECT seq,at,body FROM records WHERE kind='conversation_reset' AND conversationId=? ORDER BY seq DESC LIMIT 10").all(id).map(decodeRecord);
    },
    commit(runId, plan, messageId, workId) {
      db.transaction(() => {
        if (store.runCancelled(runId)) throw new AgentRuntimeError('CANCELLED', 'Policy was cancelled before commit; no effects committed');
        if (plan.modelWrites && store.mode() !== 'active') throw Error('Agent autonomy changed before commit; no effects committed');
        for (const [id, session] of Object.entries(plan.sessions || {})) {
          if (store.session(id).revision !== session.expectedRevision) throw new AgentRuntimeError('CONVERSATION_CONFLICT', 'Conversation changed before commit; no effects committed');
        }
        const work = workId ? decode(db.query('SELECT * FROM work WHERE id=?').get(workId))?.value : null;
        const parentId = work?.actionId || work?.outcome?.id;
        const source = messageId || (parentId ? store.action(parentId)?.messageId : work?.messageId) || null;
        store.plan(messageId || runId, plan.actions || [], source);
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
      if (Array.isArray(message.reactions)) db.query('INSERT OR REPLACE INTO reaction_snapshots(id,body,observed) VALUES(?,?,?)').run(id, JSON.stringify(message.reactions), now);
      return changed && eligible ? id : null;
    },
    reactions(chat, id) {
      const message = store.message(id);
      if (!message?.value || normalize(message.chat) !== normalize(chat)) throw new AgentRuntimeError('NOT_FOUND', 'Recorded message not found in this chat.');
      const snapshot = db.query('SELECT body,observed FROM reaction_snapshots WHERE id=?').get(id);
      if (!snapshot) throw new AgentRuntimeError('NOT_FOUND', 'No reaction snapshot has been observed for this message yet.');
      let reactions;
      try { reactions = JSON.parse(snapshot.body); } catch { throw new AgentRuntimeError('INVALID_DATA', 'Invalid reaction snapshot.'); }
      if (!Array.isArray(reactions) || reactions.some(r => !r || typeof r.key !== 'string' || typeof r.emoji !== 'string' || !Number.isInteger(r.count) || r.count < 1 || typeof r.self !== 'boolean'))
        throw new AgentRuntimeError('INVALID_DATA', 'Invalid reaction snapshot.');
      return { ok: true, messageId: id, chat: message.chat, reactions: publicBadges(reactions), observedAt: new Date(snapshot.observed).toISOString() };
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
      return db.query('SELECT chat,COUNT(*) count,MIN(time) first,MAX(time) last FROM messages GROUP BY chat ORDER BY last DESC').all();
    },
    history(chat, limit = 50) { return db.query('SELECT * FROM messages WHERE lower(chat)=lower(?) ORDER BY time DESC,seq DESC LIMIT ?').all(chat, Math.max(1, Math.min(200, limit))).reverse().map(decode); },
    search(query, chat = null) { return db.query('SELECT * FROM messages WHERE (? IS NULL OR chat=?) AND instr(lower(body),lower(?))>0 ORDER BY time DESC LIMIT 100').all(chat, chat, query).map(decode); },
    record(runId, kind, value) {
      const link = item => typeof item === 'string' ? item : null;
      db.query('INSERT INTO records(runId,kind,body,at,messageId,policyRunId,conversationId) VALUES(?,?,?,?,?,?,?)')
        .run(runId, kind, Bun.YAML.stringify(yamlLogValue(value), null, 2), Date.now(), link(value?.context?.messageId), link(value?.policyRunId), link(value?.conversationId));
    },
    records(limit = 100) { return db.query('SELECT * FROM records ORDER BY seq DESC LIMIT ?').all(Math.min(limit, 500)).map(decodeRecord); },
    messageRuns(messageId) {
      const runs = db.query("SELECT runId FROM records WHERE kind='policy_input' AND messageId=? ORDER BY seq DESC LIMIT 10").all(messageId);
      return runs.map(({ runId }) => {
        const policy = db.query("SELECT * FROM records WHERE runId=? AND kind IN ('policy_input','policy_attributes','policy_result','policy_failed') ORDER BY seq").all(runId).map(decodeRecord);
        const modelIds = db.query("SELECT DISTINCT runId FROM records WHERE kind IN ('agent_input','agent_result') AND policyRunId=? LIMIT 20").all(runId);
        const models = modelIds.flatMap(({ runId }) => db.query('SELECT * FROM records WHERE runId=? ORDER BY seq DESC LIMIT 300').all(runId).reverse().map(decodeRecord));
        return { policy, models };
      });
    },
    plan(runId, actions, messageId = store.message(runId)?.id || null) {
      db.transaction(() => {
        if (db.query("SELECT COUNT(*) n FROM actions WHERE state='pending'").get().n + actions.length > 500) throw Error('Pending action limit reached');
        for (const action of actions) {
          const id = action.id || randomUUID();
          db.query('INSERT INTO actions(id,body,runId,due,created,state) VALUES(?,?,?,?,?,?)').run(id, JSON.stringify(action), runId, action.due || Date.now(), Date.now(), action.cancelled ? 'cancelled' : 'pending');
          if (messageId) db.query('INSERT INTO action_sources(actionId,messageId) VALUES(?,?)').run(id, messageId);
        }
      }).immediate();
    },
    actions() { return [...db.query("SELECT a.*,s.messageId FROM actions a LEFT JOIN action_sources s ON s.actionId=a.id WHERE state IN ('pending','running') ORDER BY due,created").all(),
      ...db.query("SELECT a.*,s.messageId FROM actions a LEFT JOIN action_sources s ON s.actionId=a.id WHERE state NOT IN ('pending','running') ORDER BY created DESC LIMIT 100").all()].map(decode); },
    messageActions(messageId) { return db.query('SELECT a.*,s.messageId FROM actions a JOIN action_sources s ON s.actionId=a.id WHERE s.messageId=? ORDER BY created DESC LIMIT 200').all(messageId).map(decode); },
    cancel(id) { return db.query("UPDATE actions SET state='cancelled' WHERE id=? AND state='pending'").run(id).changes === 1; },
    action(id) { return decode(db.query('SELECT a.*,s.messageId FROM actions a LEFT JOIN action_sources s ON s.actionId=a.id WHERE a.id=?').get(id)); },
    claimAction(now = Date.now()) {
      return db.transaction(() => {
        const row = db.query("SELECT a.*,s.messageId FROM actions a LEFT JOIN action_sources s ON s.actionId=a.id WHERE state='pending' AND due<=? ORDER BY due,created LIMIT 1").get(now);
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
        db.query("DELETE FROM settings WHERE key='cancelRun'").run();
        db.query("UPDATE messages SET state='observed' WHERE state='pending' AND time<?").run(Date.parse(activatedAt));
        db.query("UPDATE actions SET state='uncertain',result=? WHERE state='running'").run(JSON.stringify({ error: 'Interrupted attempt; no automatic retry.' }));
        db.query("UPDATE actions SET state='missed' WHERE state='pending' AND due<? AND COALESCE(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END,'invalid')!='wake'").run(Date.parse(activatedAt));
      }).immediate();
    },
    close() { db.close(); },
  };
  return store;
}
