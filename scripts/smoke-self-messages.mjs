import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { agentStore } from '../src/agent/store.mjs';
import { intake } from '../src/agent/intake.mjs';

const activatedAt = '2026-09-30T12:00:00.000Z';
const config = { alerts: { mentionNames: ['My Name'], ignoreAuthors: [] }, debug: { echoLoop: false } };
const mk = (id, author, time, text) => ({ id, author, time, text, mentions: [] });
const store = agentStore(':memory:');
try {
  // The cutoff excludes older incoming messages, while a self-authored outgoing
  // message does not mask the incoming message observed immediately before it.
  const cutoffIds = intake({ store, chat: 'Coworker', activatedAt, config, messages: [
    mk('old-incoming', 'Coworker', '2026-09-30T11:59:59.000Z', 'before activation'),
    mk('incoming-near-send', 'Coworker', '2026-09-30T12:00:00.100Z', 'question immediately before send'),
    mk('outgoing-near-send', 'My Name', '2026-09-30T12:00:00.101Z', 'my outgoing reply'),
  ], reactions: {} });
  assert.equal(cutoffIds.length, 1);
  assert.equal(store.message(cutoffIds[0]).value.id, 'incoming-near-send');
  const history = store.history('Coworker');
  assert.deepEqual(history.map(row => [row.value.id, row.state]), [
    ['old-incoming', 'observed'],
    ['incoming-near-send', 'pending'],
    ['outgoing-near-send', 'observed'],
  ], 'old and self-authored messages remain retained but are not queued');

  // A self-chat is the deliberate harness exception for self-authored messages.
  const selfIds = intake({ store, chat: 'My Name (You)', activatedAt, config, messages: [
    mk('self-chat-outgoing', 'My Name', '2026-09-30T12:01:00.000Z', 'self-chat fixture'),
  ], reactions: {} });
  assert.equal(selfIds.length, 1);
  assert.equal(store.message(selfIds[0]).value.id, 'self-chat-outgoing');

  // Explicit echo-loop mode bypasses activation/self filtering for its harness.
  const echoIds = intake({ store, chat: 'Coworker', activatedAt, config: { ...config, debug: { echoLoop: true } }, messages: [
    mk('echo-self', 'My Name', 'invalid timestamp', 'echo fixture'),
  ], reactions: {} });
  assert.equal(echoIds.length, 1);
  assert.equal(store.message(echoIds[0]).value.id, 'echo-self');
  console.log('Agent intake smoke passed: cutoff, adjacent incoming/self messages, self-chat and echo-loop exceptions.');
} finally { store.close(); }
