import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { DASHBOARD_PAGE } from '../src/dashboard-page.mjs';
import { buildActivityGroups } from '../src/dashboard-activity.mjs';
import { filterActivityAfter, parseActivityDate } from '../src/activity-filter.mjs';

const local = '2026-01-02T11:30:00.123', cutoff = new Date(local).toISOString();
assert.equal(parseActivityDate(local), cutoff);
for (const value of ['', 'bad', '2026-02-30T12:00', '2026-01-02T25:00', '2026-01-02', '2026-01-02T11:30Z']) assert.equal(parseActivityDate(value), null);
assert.equal(parseActivityDate(local, false), null, 'native badInput/step errors stay invalid');
assert.equal(parseActivityDate('2026-01-02T11:30'), new Date('2026-01-02T11:30').toISOString());

const stamp = hours => new Date('2026-01-02T' + hours + ':00:00.000').toISOString();
const record = (id, at, stage = 'message', start = at) => ({ kind: 'flow', flowId: id, flowStartedAt: start, at, stage, chat: 'Alice', latest: { author: 'Alice', text: id } });
const items = [record('new', stamp('12')), record('old', stamp('22'), 'effect', stamp('10')), record('old', stamp('10'))];
const field = { value: '', validity: { valid: true }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const elements = { activitySince: field, clearActivity: {}, showAllActivity: {}, activityClearState: {} };
const document = { activeElement: field };
const requests = [], notifications = [];
const api = (path, method, body) => new Promise((resolve, reject) => requests.push({ path, method, body, resolve, reject }));
const localDateTime = at => { const d = new Date(at); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, -1); };
// Exercise the shipped input/save handlers, including their async serialization.
const start = DASHBOARD_PAGE.indexOf('  function syncDateFilter()');
const end = DASHBOARD_PAGE.indexOf('  for (const [id, path, text]', start);
assert(start >= 0 && end > start);
const controls = new Function('$', 'document', 'parseActivityDate', 'filterActivityAfter', 'buildActivityGroups', 'localDateTime', 'api', 'items', 'notify', `
  let activitySaving = false, activityDirty = false, activityDateInvalid = false, activitySaveError = '', clearedThrough = null, activityGeneration = 0;
  let groups = [], selected = 'old', renders = 0;
  const setText = (id, text) => $(id).textContent = text;
  function groupMessages() { groups = buildActivityGroups(filterActivityAfter(items, clearedThrough)); }
  function renderMessages() { renders++; if (!groups.some(g => g.id === selected)) selected = groups[0]?.id ?? null; renderDateFilter(); }
  function renderFlow() {}
  ${DASHBOARD_PAGE.slice(start, end)}
  groupMessages(); renderDateFilter();
  return { snapshot: () => ({ clearedThrough, activityDirty, activitySaving, activityGeneration, activityDateInvalid, selected, renders, ids: groups.map(g => g.id) }), select: id => { selected = id; renderMessages(); }, pollView: (generation, through) => { if (generation === activityGeneration && !activityDirty && !activitySaving) clearedThrough = through; groupMessages(); renderMessages(); } };
`)(id => elements[id], document, parseActivityDate, filterActivityAfter, buildActivityGroups, localDateTime, api, items, (message, error) => notifications.push({ message, error }));
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const input = value => { field.value = value; field.oninput(); };

input(local);
assert.equal(controls.snapshot().clearedThrough, cutoff, 'valid input applies before any server response');
assert.deepEqual(controls.snapshot().ids, ['new'], 'old flow stays hidden despite late handling');
assert.equal(requests.length, 1);
assert.equal(field.disabled, undefined, 'typing remains enabled during a save');
const staleGeneration = controls.snapshot().activityGeneration;
input('2026-01-02T13:00');
const latest = new Date('2026-01-02T13:00').toISOString();
assert.deepEqual(controls.snapshot().ids, []);
assert.equal(requests.length, 1, 'saves serialize; latest edit is queued');
input('');
assert.equal(controls.snapshot().clearedThrough, latest, 'empty/incomplete input must not clear the filter');
assert.equal(field.attributes['aria-invalid'], 'true');
assert.equal(requests.length, 1);
controls.pollView(staleGeneration, null);
assert.equal(controls.snapshot().clearedThrough, latest, 'old polls cannot reset a local edit');
field.onblur();
assert.equal(field.value, localDateTime(latest), 'blur restores the last valid input');
requests[0].resolve({ clearedThrough: cutoff }); await settle();
assert.equal(requests.length, 2);
assert.deepEqual(requests[1].body, { through: latest }, 'older save acknowledgement cannot replace the latest date');
requests[1].resolve({ clearedThrough: latest }); await settle();
assert.equal(controls.snapshot().activityDirty, false);
controls.pollView(staleGeneration, null);
assert.equal(controls.snapshot().clearedThrough, latest, 'poll started during save stays stale after acknowledgement');

input('2026-01-02T09:00');
assert.equal(controls.snapshot().ids.length, 2, 'earlier dates restore cached history immediately');
requests[2].resolve({}); await settle();
controls.select('old');
assert.equal(elements.clearActivity.disabled, false);
elements.clearActivity.onclick();
assert.equal(controls.snapshot().clearedThrough, stamp('10'), 'button uses exactly the highlighted message timestamp');
assert.deepEqual(controls.snapshot().ids, ['new'], 'After excludes the selected message and older ones');
requests[3].resolve({}); await settle();

input('2026-01-02T14:00'); requests[4].reject(new Error('Fixture save failure')); await settle();
assert.equal(controls.snapshot().activityDirty, true);
assert.equal(controls.snapshot().clearedThrough, new Date('2026-01-02T14:00').toISOString(), 'save failure keeps the valid local filter');
assert.equal(notifications.length, 1);
elements.showAllActivity.onclick();
assert.equal(controls.snapshot().clearedThrough, null);
assert.equal(field.value, '');
assert.deepEqual(controls.snapshot().ids, ['new', 'old']);
requests[5].resolve({}); await settle();
assert.equal(controls.snapshot().activityDirty, false);
assert.equal(elements.showAllActivity.disabled, true);
console.log('PASS live After filter, invalid/blank retention, exact selected timestamp, earlier-date restore, serialized latest-wins saves, stale polls and save failure.');
