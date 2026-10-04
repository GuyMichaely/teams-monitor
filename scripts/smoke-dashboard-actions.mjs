import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { renderActionCards } from '../src/dashboard-actions.mjs';

const now = Date.now();
const actions = [
  { id: 'later', state: 'pending', due: now + 60_000, created: now - 1000, value: { kind: 'message', chat: 'Project <chat>', text: 'Hello' }, messageId: 'message-1' },
  { id: 'ready', state: 'pending', due: now - 1000, value: { kind: 'alert', title: 'Check this' } },
  { id: 'running', state: 'running', value: { kind: 'wake', prompt: 'Follow up' } },
  { id: 'schedule:status-1', source: 'schedule', state: 'pending', due: now + 30_000, created: now, value: { kind: 'status', presence: 'away' } },
  ...['completed', 'cancelled', 'failed', 'missed', 'uncertain', 'blocked', 'superseded'].map(state => ({ id: state, state, value: { kind: 'message', chat: 'Done' }, result: { detail: `result ${state}` } })),
];

const all = renderActionCards(actions, 'all', now);
assert.match(all, /Scheduled/);
assert.match(all, /Queued/);
assert.match(all, /Running/);
assert.match(all, /Completed/);
assert.match(all, /Cancelled/);
assert.match(all, /Failed/);
assert.match(all, /Missed/);
assert.match(all, /Uncertain/);
assert.match(all, /Blocked/);
assert.match(all, /Superseded/);
assert.match(all, /Availability · Appear away/);
assert.match(all, /data-action-cancel="schedule:status-1"/);
assert.match(all, /Project &lt;chat&gt;/);
assert.match(all, /data-action-message="message-1"/);
assert.match(all, /data-action-cancel="ready"/);
assert.doesNotMatch(all, /data-action-cancel="completed"/);
assert.match(renderActionCards(actions, 'pending', now), /data-action-card="later"/);
assert.match(renderActionCards(actions, 'pending', now), /data-action-card="ready"/);
assert.doesNotMatch(renderActionCards(actions, 'pending', now), /data-action-card="running"/);
assert.match(renderActionCards(actions, 'running', now), /Follow up/);
for (const action of actions.slice(4)) assert.match(renderActionCards(actions, 'finished', now), new RegExp(`data-action-card="${action.id}"`));
assert.match(all, /value:/);
assert.match(all, /result:/);

console.log('Dashboard action cards smoke passed.');
