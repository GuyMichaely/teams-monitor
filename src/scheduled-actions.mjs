// Durable one-shot jobs. Claim commits before touching Teams; uncertain sends never replay.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './local-paths.mjs';
import { normalizeStatus } from './teams-presence.mjs';
import { isReplyAllowed } from './reply-policy.mjs';

export const SCHEDULE_FILE = join(DATA_DIR, 'scheduled-actions.sqlite');
export const SCHEDULE_GRACE_MS = 300_000;
const states = new Set(['pending', 'running', 'completed', 'cancelled', 'missed', 'blocked', 'failed', 'uncertain', 'superseded']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const bad = (message, httpCode = 400) => Object.assign(new Error(message), { httpCode });
export const scheduleError = (code) => Object.assign(new Error(code), { scheduleCode: code });
const details = {
  blocked: 'Blocked by current Teams reply permissions.',
  missed: 'Scheduled time passed while stopped, or more than five minutes late.',
  stopped: 'Orchestrator stopped before execution.',
  draft: 'Chat contains an unsent draft; it was left unchanged.',
  destination: 'Exact recipient could not be confirmed; no message sent.',
  expired: 'Execution window expired before sending.',
  config: 'Current config could not be verified; no action attempted.',
  uncertain: 'Outcome unconfirmed. Check Teams before scheduling again; no automatic retry.',
  superseded: 'A newer status selection superseded this change.',
};

function validateAction(body) {
  if (!body || !['message', 'status'].includes(body.kind)) throw bad('Choose message or status.');
  if (body.kind === 'message') {
    if (typeof body.chat !== 'string' || !body.chat.trim() || body.chat.length > 300) throw bad('Enter an exact chat name (up to 300 characters).');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000) throw bad('Enter a message (up to 8000 characters).');
    return { kind: 'message', chat: body.chat.trim(), text: body.text, presence: null };
  }
  return { kind: 'status', chat: null, text: null, presence: normalizeStatus(body.presence) };
}

function present(row) {
  try {
    if (!uuid.test(row.id) || !states.has(row.state) || !Number.isSafeInteger(row.due) || !Number.isSafeInteger(row.created)) throw Error();
    validateAction(row);
    return { id: row.id, kind: row.kind, chat: row.chat, text: row.text, presence: row.presence,
      dueAt: new Date(row.due).toISOString(), createdAt: new Date(row.created).toISOString(), updatedAt: new Date(row.updated).toISOString(), state: row.state, detail: row.detail || '' };
  } catch { return { id: uuid.test(row.id) ? row.id : null, state: 'invalid', detail: 'Invalid schedule format; not executable.' }; }
}

export function createScheduleStore(file = SCHEDULE_FILE, clock = Date.now) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, chat TEXT, text TEXT, presence TEXT,
    due INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', attempt TEXT
  ); CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state, due);`);
  const get = id => db.query('SELECT * FROM schedules WHERE id=?').get(id);
  const finish = (id, attempt, state, detail = '') => {
    if (!states.has(state) || ['pending', 'running'].includes(state)) throw bad('Invalid result state.');
    db.query("UPDATE schedules SET state=?, detail=?, updated=? WHERE id=? AND state='running' AND attempt=?").run(state, detail, clock(), id, attempt);
    return present(get(id));
  };
  return {
    create(body) {
      const action = validateAction(body);
      if (typeof body.dueAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(body.dueAt)) throw bad('Choose a date/time with a timezone.');
      const due = Date.parse(body.dueAt), now = clock();
      if (!Number.isFinite(due)) throw bad('Invalid date/time.');
      const wallTime = new Date(body.dueAt.slice(0, 19) + 'Z');
      if (!Number.isFinite(wallTime.getTime()) || wallTime.toISOString().slice(0, 19) !== body.dueAt.slice(0, 19)) throw bad('Invalid calendar date/time.');
      const id = body.requestId ?? randomUUID();
      if (!uuid.test(id)) throw bad('Invalid request ID.');
      return db.transaction(() => {
        const old = get(id);
        if (old) {
          if (old.kind !== action.kind || old.chat !== action.chat || old.text !== action.text || old.presence !== action.presence || old.due !== due) throw bad('Request ID already used for another schedule.', 409);
          return present(old);
        }
        if (due <= now || due > now + 366 * 86400_000) throw bad('Choose a future date within the next year.');
        if (db.query("SELECT count(*) AS n FROM schedules WHERE state IN ('pending','running')").get().n >= 500) throw bad('Maximum 500 pending/running schedules.', 409);
        db.query("INSERT INTO schedules(id,kind,chat,text,presence,due,created,updated,state) VALUES(?,?,?,?,?,?,?,?,'pending')").run(id, action.kind, action.chat, action.text, action.presence, due, now, now);
        return present(get(id));
      }).immediate();
    },
    list() {
      const pending = db.query("SELECT * FROM schedules WHERE state IN ('pending','running') ORDER BY due,created").all();
      const recent = db.query("SELECT * FROM schedules WHERE state NOT IN ('pending','running') ORDER BY updated DESC,created DESC LIMIT 100").all();
      return [...pending, ...recent].map(present);
    },
    cancel(id) {
      if (!uuid.test(id)) throw bad('Invalid schedule ID.');
      return db.transaction(() => {
        const row = get(id);
        if (!row) throw bad('Schedule not found.', 404);
        if (!['pending', 'cancelled'].includes(row.state)) throw bad('Only pending schedules can be cancelled; execution may already have started.', 409);
        db.query("UPDATE schedules SET state='cancelled', updated=?,detail='Cancelled before execution.' WHERE id=? AND state='pending'").run(clock(), id);
        return present(get(id));
      }).immediate();
    },
    recover(activatedAt) {
      // Called by the sole orchestrator, not by GUI startup/refresh.
      const now = clock();
      db.transaction(() => {
        db.query("UPDATE schedules SET state='uncertain',detail=?,updated=? WHERE state='running'").run(details.uncertain, now);
        db.query("UPDATE schedules SET state='missed',detail=?,updated=? WHERE state='pending' AND due<?").run(details.missed, now, Date.parse(activatedAt));
      }).immediate();
    },
    claim() {
      return db.transaction(() => {
        const now = clock();
        db.query("UPDATE schedules SET state='missed',detail=?,updated=? WHERE state='pending' AND due<?").run(details.missed, now, now - SCHEDULE_GRACE_MS);
        const row = db.query("SELECT * FROM schedules WHERE state='pending' AND due<=? ORDER BY due,created,id LIMIT 1").get(now);
        if (!row) return null;
        const view = present(row);
        if (view.state === 'invalid') {
          db.query("UPDATE schedules SET state='failed',detail='Invalid schedule format; not executed.',updated=? WHERE id=?").run(now, row.id);
          return null;
        }
        const attempt = randomUUID();
        db.query("UPDATE schedules SET state='running',attempt=?,updated=? WHERE id=? AND state='pending'").run(attempt, now, row.id);
        return { ...view, state: 'running', attempt };
      }).immediate();
    },
    finish, close: () => db.close(),
  };
}

export async function runScheduledAction({ store, loadConfig, sendMessage, setPresence, stopped = () => false, now = Date.now, audit = () => {} }) {
  if (stopped()) return null;
  const job = store.claim();
  if (!job) return null;
  let state = 'uncertain', detail = details.uncertain;
  const guard = async () => {
    if (stopped()) throw scheduleError('stopped');
    if (now() > Date.parse(job.dueAt) + SCHEDULE_GRACE_MS) throw scheduleError('expired');
    let cfg;
    try { cfg = await loadConfig(); } catch { throw scheduleError('config'); }
    if (job.kind === 'message' && !isReplyAllowed(cfg, job.chat)) throw scheduleError('blocked');
    return cfg;
  };
  try {
    const cfg = await guard();
    if (job.kind === 'message') {
      const result = await sendMessage(job.chat, job.text, cfg.port, guard, { expiresAt: Date.parse(job.dueAt) + SCHEDULE_GRACE_MS });
      if (result === 'sent') { state = 'completed'; detail = 'Teams send button clicked; delivery/read receipt not verified.'; }
    } else {
      const result = await setPresence(job.presence, cfg, Date.parse(job.dueAt) + SCHEDULE_GRACE_MS);
      if (result.expired) { if (!result.attempted) { state = 'missed'; detail = details.expired; } }
      else if (result.superseded) { state = 'superseded'; detail = details.superseded; }
      else if (result.verified && result.value === job.presence) { state = 'completed'; detail = 'Teams status verified.'; }
    }
  } catch (error) {
    if (error.scheduleCode && Object.hasOwn(details, error.scheduleCode)) {
      state = error.scheduleCode === 'blocked' ? 'blocked' : ['expired', 'stopped'].includes(error.scheduleCode) ? 'missed' : 'failed';
      detail = details[error.scheduleCode];
    }
  }
  const result = store.finish(job.id, job.attempt, state, detail);
  try { await audit({ kind: 'scheduled_action', scheduleId: job.id, action: job.kind, state, detail }); } catch { /* audit failure cannot change delivery outcome */ }
  return result;
}
