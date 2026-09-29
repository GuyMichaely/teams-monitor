import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestPhonePolicySync } from '../src/alerts.mjs';
import { saveFcmRegistration, readAlertRuntime, recordFcmBackoff } from '../src/alert-runtime.mjs';
import { DIAGNOSTICS_LOG } from '../src/gui-diagnostics.mjs';

const home = process.env.TEAMS_MONITOR_HOME;
assert(home.includes('teams-monitor-smoke-'));
const credential = join(home, 'config', 'fake-fcm.json');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
await writeFile(credential, JSON.stringify({ project_id: 'test', client_email: 'test@example.invalid',
  token_uri: 'https://oauth.example.invalid/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
const config = { alerts: { transport: 'websocket', fallbackTransport: null, fcm: { serviceAccountFile: credential } } };
await saveFcmRegistration({ fid: 'fake-policy-registration' });
const originalFetch = globalThis.fetch;
const messages = [];
let failure = false;
try {
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth.example.invalid/token') return Response.json({ access_token: 'fake', expires_in: 3600 });
    assert(String(url).startsWith('https://fcm.googleapis.com/v1/projects/test/'));
    messages.push(JSON.parse(options.body).message);
    return failure ? Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503, headers: { 'Retry-After': '60' } })
      : Response.json({ name: 'projects/test/messages/wake-up' });
  };
  const before = await readAlertRuntime('websocket');
  assert.deepEqual(await requestPhonePolicySync(config), { accepted: true });
  const message = messages[0];
  assert.equal(message.data.kind, 'control');
  assert.equal(message.data.actions, 'sync_policy');
  assert.equal(message.data.primaryTransport, undefined, 'delayed wake-up cannot carry an old policy');
  assert.equal(message.data.websocketWanted, undefined);
  assert.equal(message.notification, undefined, 'no visible notification or alarm');
  assert.deepEqual(message.android, { priority: 'HIGH', ttl: '60s', collapse_key: 'delivery-policy-sync' });
  assert.equal(message.fid, 'fake-policy-registration');
  assert.deepEqual((await readAlertRuntime('websocket')).delivery, before.delivery, 'acceptance must not declare transport recovered');
  failure = true;
  assert.equal((await requestPhonePolicySync(config)).accepted, false);
  assert.equal((await requestPhonePolicySync(config)).reason, 'fcm_backoff');
  assert.equal(messages.length, 2, 'backoff suppresses extra sends');
  await recordFcmBackoff(null, { delayMs: 0 });
  assert.equal((await requestPhonePolicySync({ alerts: { fcm: { serviceAccountFile: join(home, 'missing.json') } } })).reason, 'FCM_CONFIG');
  const log = await readFile(DIAGNOSTICS_LOG, 'utf8');
  for (const kind of ['phone_policy_sync_accepted', 'phone_policy_sync_failed', 'phone_policy_sync_deferred']) assert(log.includes(kind));
  assert(!log.includes('fake-policy-registration'));
  const phone = await readFile(new URL('../android-app/app/src/main/java/com/guymichaely/teamsmonitor/FcmMessagingService.kt', import.meta.url), 'utf8');
  assert.match(phone, /if \("sync_policy" in actions\) \{[\s\S]*?NotificationTransport\.sync\(this\)[\s\S]*?return/);
  console.log('Silent current-policy wake-up, FID targeting, backoff, failure logs and no false recovery passed.');
} finally { globalThis.fetch = originalFetch; }
