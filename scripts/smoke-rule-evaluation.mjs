import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { evaluateRules, isMentioned, validateAutomation, validateDeterministicRules } from '../src/deterministic-rules.mjs';

const config = { alerts: { mentionNames: ['Guy Michaely', 'Guy'], ignoreAuthors: ['Muted Person'] } };
const rule = (id, when, action = { type: 'alert_phone' }, extra = {}) => ({ id, when, action, ...extra });

const validated = validateAutomation({
  agent: { initiate: { when: 'unmatched', actions: ['alert_phone', 'reply'] }, timeoutMs: 1234 },
  rules: [rule(' padded ', { field: 'text', match: 'contains', value: ' hi ' }, { type: 'reply', text: 'Hello' }, { agent: { cancel: true } })],
});
assert.deepEqual(validated.agent, { initiate: { when: 'unmatched', actions: ['alert_phone', 'reply'] }, timeoutMs: 1234 });
assert.deepEqual(validated.rules[0], { id: 'padded', enabled: true, when: { field: 'text', match: 'contains', value: 'hi' }, action: { type: 'reply', text: 'Hello' }, agent: { cancel: true, modify: false } });
assert.deepEqual(validateAutomation({}).agent, { initiate: { when: 'never', actions: [] }, timeoutMs: 5000 });

for (const invalid of [
  null, {}, [rule('x', { type: 'nope' })], [rule('x', { field: 'bad', match: 'exact', value: 'v' })],
  [rule('x', { field: 'text', match: 'contains_number', value: '3x' })],
  [rule('x', { field: 'author', match: 'contains_number', value: '3' })],
  [rule('x', { type: 'mention' }, { type: 'reply' })],
  [rule('x', { type: 'mention' }), rule('x', { type: 'mention' })],
  [rule('x', { type: 'mention' }, { type: 'ignore' }, { extra: true })],
  [rule('x', { type: 'mention' }, { type: 'ignore' }, { agent: { cancel: 'yes' } })],
  [rule('x', { all: [] })], [rule('x', { any: Array(21).fill({ type: 'mention' }) })],
  [rule('x', { not: null })], [rule('x', { not: { type: 'mention' }, all: [{ type: 'mention' }] })],
]) assert.throws(() => validateDeterministicRules(invalid));
for (const automation of [
  { unknown: true }, { agent: { initiate: { when: 'sometimes', actions: [] } } },
  { agent: { initiate: { when: 'always', actions: ['ignore'] } } },
  { agent: { initiate: { when: 'always', actions: ['reply', 'reply'] } } },
  { agent: { timeoutMs: 30001 } },
]) assert.throws(() => validateAutomation(automation));

assert.equal(isMentioned({ text: 'hey @gUy Michaely!' }, config.alerts.mentionNames), true);
assert.equal(isMentioned({ text: 'mail@Guy.com @Guyana' }, config.alerts.mentionNames), false);
assert.equal(isMentioned({ mentions: ['Guy Michaely'] }, config.alerts.mentionNames), true);

const rules = [
  rule('dm', { type: 'direct_message' }),
  rule('mention', { type: 'mention' }),
  rule('all-any', { all: [{ field: 'text', match: 'contains', value: 'urgent' }, { any: [{ field: 'author', match: 'exact', value: 'alex' }, { type: 'mention' }] }] }),
  rule('number', { field: 'text', match: 'contains_number', value: '1234' }),
  rule('disabled', { type: 'mention' }, { type: 'ignore' }, { enabled: false }),
];
const latest = { author: 'Alex', text: 'Urgent ticket #1234!', mentions: ['Guy Michaely'] };
const evaluated = evaluateRules({ chat: 'Alex', latest, config: { ...config, automation: { rules } } });
assert.deepEqual(evaluated.map(x => x.rule.id), ['dm', 'mention', 'all-any', 'number']);
assert(evaluated.every(x => x.matched));
assert.equal(evaluated[2].evaluation.conditions[1].conditions[0].matched, true);
assert.deepEqual(evaluated[3].evaluation.comparison.numericTokens, ['1234']);

// All matching rules are returned, including multiple actions that overlap.
assert.equal(evaluateRules({ chat: 'Alex', latest, config: { ...config, automation: { rules: [...rules, rule('also-match', { type: 'direct_message' })] } } }).filter(x => x.matched).length, 5);

const numberRule = [rule('n', { field: 'text', match: 'contains_number', value: '1234' })];
for (const text of ['#1234!', '(1234)', 'v2:1234, ok', 'reference 1234.']) assert.equal(evaluateRules({ chat: 'c', latest: { author: 'a', text }, config: { automation: { rules: numberRule } } })[0].matched, true, text);
for (const text of ['91234', '1234.5', 'x1234', '1234x', '1_1234']) assert.equal(evaluateRules({ chat: 'c', latest: { author: 'a', text }, config: { automation: { rules: numberRule } } })[0].matched, false, text);

for (const author of ['You', 'Guy Michaely', 'Muted Person']) {
  const blocked = evaluateRules({ chat: author, latest: { author, text: '@Guy urgent 1234', mentions: ['Guy'] }, config: { ...config, automation: { rules: rules.slice(0, 2) } } });
  assert(blocked.every(x => !x.matched));
}
assert.deepEqual(evaluateRules({ chat: 'Alex', latest: { author: 'Alex' }, config: {} }), []);
console.log('smoke-rule-evaluation: ok');
