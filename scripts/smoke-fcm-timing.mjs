import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestCurrentFcmRegistration } from '../src/alerts.mjs';
import { saveFcmRegistration } from '../src/alert-runtime.mjs';
import { DIAGNOSTICS_LOG } from '../src/gui-diagnostics.mjs';

await saveFcmRegistration({ fid: 'test-registration-secret' });
const originalFetch = globalThis.fetch;
const payloads = [];
const build = () => ({ data: { kind: 'alert', alertId: 'correlation-id', text: 'private content' }, android: { priority: 'HIGH' } });
try {
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json({ name: 'projects/test/messages/message-id' });
  };
  const sent = await requestCurrentFcmRegistration('test', 'secret-access-token', build);
  assert(Number.isFinite(Date.parse(payloads[0].message.data.fcmSendStartedAt)));
  assert.equal(sent.fcmSendStartedAt, payloads[0].message.data.fcmSendStartedAt);
  assert(Date.parse(sent.fcmAcceptedAt) >= Date.parse(sent.fcmSendStartedAt));
  assert(sent.requestDurationMs >= 0);
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    if (++calls === 1) {
      await saveFcmRegistration({ fid: 'replacement-registration-secret' });
      return Response.json({ error: { status: 'UNAVAILABLE', message: 'temporarily unavailable' } }, { status: 503 });
    }
    return Response.json({ name: 'projects/test/messages/retry-id' });
  };
  await requestCurrentFcmRegistration('test', 'secret-access-token', build);
  assert.equal(calls, 2);
  assert.equal(payloads.at(-1).message.fid, 'replacement-registration-secret');
  const raw = await readFile(DIAGNOSTICS_LOG, 'utf8');
  for (const secret of ['test-registration-secret', 'replacement-registration-secret', 'secret-access-token', 'private content']) assert(!raw.includes(secret));
  const logs = raw.trim().split('\n').map(JSON.parse);
  assert.equal(logs.filter(l => l.kind === 'fcm_send_started').length, 3);
  assert.equal(logs.filter(l => l.kind === 'fcm_send_accepted').length, 2);
  assert.equal(logs.filter(l => l.kind === 'fcm_send_failed').length, 1);
  assert(logs.every(l => l.alertId === 'correlation-id'));
  assert.notEqual(logs.at(-1).registrationGeneration, logs[0].registrationGeneration);
  console.log('FCM attempt timing/correlation, failure and registration retry logging passed.');
} finally { globalThis.fetch = originalFetch; }
