import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { Usage } from '@openai/agents';
import { agentStore } from '../src/agent/store.mjs';
import { personNoteSnapshot } from '../src/agent/person-notes.mjs';
import { agentAPI } from '../src/agent/api.mjs';
import { agentReview } from '../src/agent/tools.mjs';
import { blankPlan } from '../src/agent/plan.mjs';
import { teamsOperation } from '../src/teams-broker.mjs';

const store = agentStore(':memory:');
const brokerStore = agentStore();
try {
  const url = path => new URL(`http://localhost${path}`);
  assert.deepEqual(await agentAPI({ url: url('/api/agent/person-notes'), method: 'PUT', body: { name: 'Alex', note: 'Owns the rollout.' }, store }),
    { name: 'Alex', note: 'Owns the rollout.' });
  await agentAPI({ url: url('/api/agent/person-notes'), method: 'PUT', body: { name: 'Blair', note: 'Reviews operations.' }, store });
  await agentAPI({ url: url('/api/agent/chat-members'), method: 'PUT', body: { chat: 'Project Group', members: ['Alex', 'Blair', 'Casey'] }, store });
  assert.deepEqual(personNoteSnapshot(store, { chatName: 'Project Group', authorName: 'Alex' }), {
    author: { name: 'Alex', note: 'Owns the rollout.' },
    groupMembers: [{ name: 'Blair', note: 'Reviews operations.' }],
    membership: { source: 'manual', members: ['Alex', 'Blair', 'Casey'] },
  });
  assert.deepEqual(personNoteSnapshot(store, { chatName: 'Project Group', authorName: 'New speaker' }).groupMembers,
    [{ name: 'Alex', note: 'Owns the rollout.' }, { name: 'Blair', note: 'Reviews operations.' }],
    'known speakers are not the roster; explicitly stored members supply group notes');
  assert.equal(personNoteSnapshot(store, { chatName: 'Unlisted group', authorName: 'Alex' }).membership.source, 'unavailable');
  await teamsOperation({ operation: 'read', chat: 'Broker Group' }, {
    config: async () => ({ port: 19222 }),
    read: async chat => ({ chat, messages: [], membership: { ok: true, members: ['Alex', 'Blair'] } }),
  });
  assert.deepEqual(brokerStore.chatMembers('Broker Group'), { chat: 'Broker Group', members: [], source: 'unavailable' },
    'broker output cannot turn an unverified roster into membership');
  brokerStore.chatMembers('Broker Group', ['Casey'], 'manual');
  await teamsOperation({ operation: 'read', chat: 'Broker Group' }, {
    config: async () => ({ port: 19222 }),
    read: async chat => ({ chat, messages: [{ author: 'Observed Speaker' }], membership: { ok: true, members: ['Observed Speaker'] } }),
  });
  assert.deepEqual(brokerStore.chatMembers('Broker Group'), { chat: 'Broker Group', members: ['Casey'], source: 'manual' },
    'observed speakers and unverified broker membership cannot alter the explicit roster');

  const listed = await agentAPI({ url: url('/api/agent/person-notes'), method: 'GET', body: {}, store });
  assert.equal(listed.people.length, 2);
  assert.equal(listed.memberships[0].source, 'manual');
  assert.deepEqual(await agentAPI({ url: url('/api/agent/person-notes?name=Blair'), method: 'DELETE', body: {}, store }), { ok: true, name: 'Blair' });
  assert.equal(store.personNote('Blair').note, '');
  await agentAPI({ url: url('/api/agent/person-notes'), method: 'PUT', body: { name: 'Blair', note: 'Reviews operations.' }, store });

  const requests = [];
  const model = { async getResponse(request) {
    requests.push(JSON.stringify(request.input));
    return { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done' }] }], usage: new Usage({ requests: 1 }) };
  } };
  const configLoader = async () => ({ brain: { provider: 'nvidia' }, agent: { timeoutMs: 30000, maxTurns: 2 } });
  const invoke = context => agentReview({ prompt: 'Review this event.', options: {}, context, source: 'fixture', version: 'v1',
    plan: blankPlan(), store, configLoader, model });
  const wake = { trigger: 'wake', prompt: 'Continue', chatName: 'Project Group', authorName: 'Alex', now: new Date().toISOString() };
  const first = await invoke(wake);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert(requests.at(-1).includes('Owns the rollout.'));
  assert(requests.at(-1).includes('Reviews operations.'));
  assert(requests.at(-1).includes('manual'));
  assert(store.records(20).some(row => row.kind === 'agent_input' && JSON.stringify(row.value.input).includes('Owns the rollout.')),
    'the exact person-note snapshot is retained in the invocation input log');
  store.personNote('Alex', 'Updated for the next call.');
  const second = await invoke(wake);
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert(requests.at(-1).includes('Updated for the next call.'));
  assert(!requests.at(-1).includes('Owns the rollout.'), 'each model call reads current note contents');
  console.log('Person-note CRUD, explicit membership, wake context, per-call freshness and invocation snapshots passed.');
} finally { store.close(); brokerStore.close(); }
