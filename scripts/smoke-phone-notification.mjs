import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notificationPayload, messageNotification } from '../src/phone-notification.mjs';
import { sendNotification, sendAlert } from '../src/alerts.mjs';
import { saveFcmRegistration } from '../src/alert-runtime.mjs';
import { blankPlan, actionAPI } from '../src/agent/plan.mjs';
import { agentStore } from '../src/agent/store.mjs';
import { executeAction, assertActionAuthority } from '../src/agent/executor.mjs';
import { permissions, permissionCeiling } from '../src/agent/permissions.mjs';

const payload = { title: 'Build failed', body: 'Project X failed.\nPlease investigate. ' };
assert.deepEqual(notificationPayload(payload), payload, 'explicit content is preserved exactly');
for (const invalid of [undefined, 'text', {}, { title: 'T', body: '' }, { title: ' ', body: 'B' },
  { ...payload, chat: 'extra' }, { title: '🚨'.repeat(65), body: 'B' },
  { title: 'T', body: '🚨'.repeat(751) }, { title: 'T', body: '\n'.repeat(2998) + 'B' }])
  assert.throws(() => notificationPayload(invalid), { code: 'INVALID_ACTION' });
assert.equal(notificationPayload({ title: 'T', body: '🚨'.repeat(750) }).body.length, 1500);
const context = { chatName: 'Project X', authorName: 'Alice', now: new Date().toISOString(),
  message: { text: 'hello\nthere ' + 'x'.repeat(240), time: '2026-10-03T12:00:00Z' } };
const formatted = messageNotification(context);
assert.equal(formatted.title, 'Alice · Project X');
assert.equal(formatted.body.length, 200); assert(!formatted.body.includes('\n')); assert(formatted.body.endsWith('…'));
const store = agentStore(':memory:'), plan = blankPlan();
const configLoader = async () => ({ replyPolicy: { mode: 'whitelist', entries: [] } });
const { api } = actionAPI({ plan, context, configLoader, store });
const first = await api.alert(payload), duplicate = await api.alert(payload);
assert.equal(first.ok, true); assert.equal(first.id, duplicate.id);
assert.equal((await api.alert({ ...payload, title: 'Different title' })).ok, true);
assert.equal((await api.alert({ ...payload, body: 'Different body' })).ok, true);
assert.equal(plan.actions.length, 3, 'dedupe includes both title and body');
assert.equal((await api.alert('old API')).error.code, 'INVALID_ACTION');
assert.equal((await api.alertMessage()).ok, true);
assert.equal(plan.actions.at(-1).title, formatted.title);
assert.equal(plan.actions.at(-1).body, formatted.body);
assert.equal(plan.actions.at(-1).time, context.message.time);
assert.equal((await api.modify(first, { body: 'Updated\nbody' })).ok, true);
assert.equal((await api.modify(first, { text: 'wrong field' })).error.code, 'INVALID_ACTION');
assert.equal((await api.delay(first, { afterMs: 5000 })).ok, true);
assert.equal((await api.cancel(first)).ok, true);
const editable = { id: 'editable', kind: 'alert', title: 'Original', body: 'Original body', due: Date.now() + 60000 };
store.plan('seed', [editable]);
const scope = { tools: ['modify_action'], modifyIds: { editable: ['body'] } };
const bounded = actionAPI({ plan: blankPlan(), context, configLoader, store, bounded: scope }).api;
assert.equal((await bounded.modify('editable', { title: 'Unauthorized' })).error.code, 'DENIED');
assert.equal((await bounded.modify('editable', { body: 'Authorized' })).ok, true);
assert.equal(store.action('editable').value.body, 'Original body', 'edits stay staged');
const reviewed = { ...editable, review: { authority: scope, fields: ['body'] } };
assert.doesNotThrow(() => assertActionAuthority(reviewed, {}, store));
assert.throws(() => assertActionAuthority(reviewed, { agent: { ceiling: { modifyIds: { editable: ['text'] } } } }, store), { code: 'DENIED' });
assert.deepEqual(permissions({ tools: ['modify_action'], modifyIds: { editable: ['title', 'body', 'text'] } },
  permissionCeiling({ agent: { ceiling: { modifyIds: { '*': ['body'] } } } })).modifyIds, { editable: ['body'] });
store.close();

const credential = join(process.env.TEAMS_MONITOR_HOME, 'config', 'fake-notification-fcm.json');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
await writeFile(credential, JSON.stringify({ project_id: 'notification-test', client_email: 'test@example.invalid',
  token_uri: 'https://oauth.example.invalid/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
await saveFcmRegistration({ fid: 'fake-notification-fid' });
const config = { alerts: { transport: 'websocket', fallbackTransport: null, fcm: { serviceAccountFile: credential },
  websocketUrl: 'http://notification.example.invalid/api/alerts' } };
const originalFetch = globalThis.fetch, websocket = [], fcm = [];
let websocketFailure = false;
try {
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth.example.invalid/token') return Response.json({ access_token: 'fake', expires_in: 3600 });
    if (String(url) === config.alerts.websocketUrl) {
      websocket.push(JSON.parse(options.body));
      return Response.json({ delivered: websocketFailure ? 0 : 1 });
    }
    assert(String(url).startsWith('https://fcm.googleapis.com/v1/projects/notification-test/'));
    fcm.push(JSON.parse(options.body).message); return Response.json({ name: 'projects/notification-test/messages/example' });
  };
  await sendNotification({ ...payload, alertId: 'same-id' }, config);
  assert.equal(websocket[0].kind, 'notification');
  assert.equal(websocket[0].title, payload.title); assert.equal(websocket[0].body, payload.body);
  assert.equal(websocket[0].chat, undefined); assert.equal(websocket[0].text, undefined);
  const jobs = agentStore(':memory:'), messagePlan = blankPlan();
  const messageApi = actionAPI({ plan: messagePlan, context, configLoader: async () => config, store: jobs }).api;
  const messageAlert = await messageApi.alertMessage();
  jobs.plan('message', messagePlan.actions);
  const sent = await executeAction({ store: jobs, loadConfig: async () => config });
  assert.equal(sent.state, 'completed'); assert.equal(websocket.at(-1).kind, 'alert');
  assert.equal(websocket.at(-1).alertId, messageAlert.id); assert.equal(websocket.at(-1).text, formatted.body);
  jobs.close();
  await sendAlert({ chat: 'Chat', author: 'Alice', text: 'stable\nmain' }, config);
  assert.equal(websocket.at(-1).kind, 'alert'); assert.equal(websocket.at(-1).text, 'stable main');
  websocketFailure = true; config.alerts.fallbackTransport = 'fcm';
  const result = await sendNotification({ ...payload, alertId: 'fallback-id' }, config);
  assert.equal(result.transport, 'fcm');
  assert.equal(websocket.at(-1).alertId, fcm.at(-1).data.alertId, 'fallback keeps one ID');
  assert.equal(fcm.at(-1).data.kind, 'notification'); assert.equal(fcm.at(-1).data.body, payload.body);
  assert.equal(fcm.at(-1).data.title, payload.title); assert.equal(fcm.at(-1).notification, undefined);
  assert.equal(fcm.at(-1).fid, 'fake-notification-fid');
  assert.equal(typeof fcm.at(-1).data.fcmSendStartedAt, 'string');
  config.alerts.transport = 'fcm'; config.alerts.fallbackTransport = null;
  await sendNotification({ title: 'x'.repeat(256), body: 'y'.repeat(3000) }, config);
  assert(Buffer.byteLength(JSON.stringify(fcm.at(-1).data)) <= 4096);
  const count = fcm.length;
  await assert.rejects(sendNotification({ title: 'T', body: 'y'.repeat(3001) }, config), { code: 'INVALID_ACTION' });
  assert.equal(fcm.length, count, 'invalid content never attempts delivery');
  console.log('General notifications: content/byte bounds, convenience, dedupe, modification, delay, WebSocket/FCM/fallback and stable protocol passed.');
} finally { globalThis.fetch = originalFetch; }
