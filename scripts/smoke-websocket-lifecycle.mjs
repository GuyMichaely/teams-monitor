import './smoke-env.mjs';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { startGui, alertClientCount, applyAlertDeliveryPolicy } from '../src/gui-server-core.mjs';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { controlState } from '../src/alert-runtime.mjs';
import { DIAGNOSTICS_LOG } from '../src/gui-diagnostics.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, description) {
  const deadline = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${description}`);
    await delay(10);
  }
}
function frame(opcode, data = Buffer.alloc(0)) {
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | data.length]), mask,
    Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]))]);
}
const server = startGui({ gui: { host: '127.0.0.1', port: 18117, authTokenEnv: 'WS_LIFECYCLE_TEST_TOKEN' } },
  { pingIntervalMs: 100, pongTimeoutMs: 150 });
const clients = [];
async function rawClient(mode = 'silent') {
  const socket = net.createConnection({ host: '127.0.0.1', port: 18117 });
  clients.push(socket);
  socket.on('error', () => {});
  let handshake = false, policyReceived = false, buffered = Buffer.alloc(0), pings = 0, pongs = 0;
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!handshake) {
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      assert.match(buffered.subarray(0, end).toString(), /101 Switching Protocols/);
      buffered = buffered.subarray(end + 4);
      handshake = true;
    }
    while (buffered.length >= 2) {
      const size = buffered[1] & 127;
      assert(size < 126);
      if (buffered.length < size + 2) return;
      const opcode = buffered[0] & 15;
      const payload = buffered.subarray(2, size + 2);
      buffered = buffered.subarray(size + 2);
      if (opcode === 1 && JSON.parse(payload.toString()).kind === 'control') policyReceived = true;
      if (opcode === 10) pongs++;
      if (opcode !== 9) continue;
      pings++;
      if (mode === 'healthy') {
        const response = frame(10, payload);
        socket.write(response.subarray(0, 3));
        setTimeout(() => { if (!socket.destroyed) socket.write(response.subarray(3)); }, 5);
      } else if (mode === 'wrong_pong') socket.write(frame(10, Buffer.from('wrong')));
    }
  });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET /ws/alerts HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await until(() => handshake, 'upgrade');
  await until(() => policyReceived, 'connection-time policy');
  assert.equal(alertClientCount(), 1);
  return { socket, pings: () => pings, pongs: () => pongs };
}
try {
  await until(() => server.server.listening, 'listen');
  const fin = await rawClient();
  fin.socket.end();
  await until(() => alertClientCount() === 0, 'TCP FIN removed without WS close');
  assert.equal(fin.pings(), 0, 'FIN cleanup should not need a heartbeat');

  await rawClient('silent');
  await until(() => alertClientCount() === 0, 'silent client expired');
  await rawClient('wrong_pong');
  await until(() => alertClientCount() === 0, 'incorrect pong cannot keep socket alive');

  const healthy = await rawClient('healthy');
  await until(() => healthy.pings() >= 4, 'multiple fragmented matching pongs');
  await delay(25); // Finish the split pong before sending another frame.
  assert.equal(alertClientCount(), 1);
  healthy.socket.write(frame(9, Buffer.from('client-ping')));
  await until(() => healthy.pongs() === 1, 'client ping answered');
  healthy.socket.write(frame(8));
  await until(() => alertClientCount() === 0, 'normal close removed');

  const abrupt = await rawClient('healthy');
  abrupt.socket.destroy();
  await until(() => alertClientCount() === 0, 'abrupt disconnect removed');
  const config = await loadConfig();
  config.alerts.transport = 'fcm';
  config.alerts.fallbackTransport = null;
  await saveConfig(config);
  await rawClient('healthy');
  await until(() => alertClientCount() === 0, 'late connection gets current FCM-only policy and closes even with healthy pongs');

  config.alerts.transport = 'websocket';
  await saveConfig(config);
  await rawClient('healthy');
  config.alerts.transport = 'fcm';
  await saveConfig(config);
  applyAlertDeliveryPolicy(await controlState(config));
  await delay(100);
  config.alerts.transport = 'websocket';
  await saveConfig(config);
  applyAlertDeliveryPolicy(await controlState(config));
  await delay(1200);
  assert.equal(alertClientCount(), 1, 'newer WebSocket policy cancels pending shutdown');
  await server.close();
  assert.equal(alertClientCount(), 0, 'server shutdown clears sockets and timers');
  const logs = (await readFile(DIAGNOSTICS_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  const reasons = logs.filter(l => l.kind === 'ws_connection_removed').map(l => l.reason);
  assert(reasons.includes('peer_end'));
  assert.equal(reasons.filter(r => r === 'pong_timeout').length, 2);
  assert(reasons.includes('peer_close'));
  assert(reasons.includes('server_shutdown'));
  console.log('WebSocket FIN, abrupt/normal close, pong timeout, invalid/fragmented pongs, client ping, shutdown and diagnostics passed.');
} finally {
  clients.forEach(socket => socket.destroy());
  if (server.server.listening) await server.close();
}
