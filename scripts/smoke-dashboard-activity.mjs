import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { buildActivityGroups } from "../src/dashboard-activity.mjs";

const base = { kind: 'flow', flowId: 'one', chat: 'Project team', at: '2026-09-23T04:12:03.000Z' };
const message = { ...base, stage: 'message', latest: { author: 'Andrew', text: 'A message' } };
const effect = (effect, status = 'ok', extra = {}) => ({ ...base, stage: 'effect', effect, status, ...extra });
const symbols = events => buildActivityGroups(events)[0].icons.map(i => i.symbol);
assert.deepEqual(symbols([effect('teams_reply'), effect('phone_alert'), message]), ['🚨', '🗣️']);
assert.deepEqual(symbols([effect('ignored', 'ignored'), message]), []);
assert.deepEqual(buildActivityGroups([effect('teams_reply'), effect('phone_alert'), { ...base, stage: 'decision', action: 'rule_actions' }, message])[0].outcomes, ['alarm', 'reply']);
assert.deepEqual(buildActivityGroups([effect('rule_skipped', 'ignored'), message])[0].outcomes, ['ignore']);
assert.deepEqual(symbols([{ ...base, stage: 'decision', action: 'alarm' }, message]), [], 'A model proposal is not a sent notification');
assert.deepEqual(symbols([effect('phone_alert', 'error'), message]), [], 'Failed actions must not appear successful');
assert.equal(buildActivityGroups([effect('phone_alert', 'error'), message])[0].error, true);
assert.deepEqual(symbols([effect('brain_actions', 'error', { results: [{ name: 'alert_phone', result: { alertId: 'x' } }, { name: 'other', error: 'failed' }] }), message]), ['🚨']);
assert.deepEqual(symbols([effect('brain_actions', 'error', { results: [{ name: 'alert_phone', error: 'failed' }] }), message]), []);
for (const record of [null, 42, 'bad', [], { kind: 'invalid_log' }, { kind: 'decision', latest: message.latest, at: base.at }, { ...message, at: 'bad' }, { ...message, latest: {} }, effect(42), { ...message, at: 123 }]) {
  const groups = buildActivityGroups([record]);
  assert.equal(groups[0].invalid, true);
  assert.equal(groups[0].error, true);
}
assert.equal(buildActivityGroups([effect('ignored')])[0].invalid, true, 'A missing message is invalid, not an adapted older format');
const grouped = buildActivityGroups([{ kind: 'decision', flowId: 'one', latest: { author: 'Wrong', text: 'Do not overwrite' } }, message]);
assert.equal(grouped[0].latest.author, 'Andrew', 'Only the message-stage record owns message metadata');
assert.equal(buildActivityGroups([{ ...effect('phone_alert'), results: 'bad' }, message]).length, 1, 'Damaged result data cannot crash the view');
assert.equal(buildActivityGroups([{ ...message, chat: 'Different chat' }, message])[0].invalid, true);
console.log('Activity trace schema, corruption handling, metadata ownership and action icons passed.');
