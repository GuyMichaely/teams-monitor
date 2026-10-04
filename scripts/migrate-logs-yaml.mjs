import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { CONFIG_FILE, DATA_DIR } from '../src/local-paths.mjs';
import { migrateLogFiles } from './migrate-log-yaml.mjs';
import { migrateAgentLogRecords } from './migrate-agent-logs-yaml.mjs';

async function checkStopped() {
  const port = Bun.YAML.parse(readFileSync(CONFIG_FILE, 'utf8')).gui?.port || 8090;
  for (const value of [port, port + 1, port + 2]) {
    const occupied = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: value });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', error => resolve(error.code !== 'ECONNREFUSED'));
    });
    if (occupied) throw Error('Stop the system before migrating logs. No live records have been changed.');
  }
}
if (import.meta.main) {
  await checkStopped();
  const files = await migrateLogFiles(DATA_DIR);
  const agent = migrateAgentLogRecords();
  console.log({ fileLogs: files.files, fileRecords: files.records, agentRecords: agent.records, invalidAgentRecords: agent.invalid || 0, agentSkipped: !!agent.skipped });
}
