import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../local-paths.mjs';

export function ownerActive(owner) {
  if (!owner) return true;
  try {
    if (existsSync(join(DATA_DIR, 'STOP'))) return false;
    const heartbeat = JSON.parse(readFileSync(join(DATA_DIR, 'heartbeat.json'), 'utf8'));
    const age = Date.now() - Date.parse(heartbeat.at);
    return Number.isInteger(owner.pid) && typeof owner.runId === 'string' && heartbeat.pid === owner.pid && heartbeat.runId === owner.runId && age >= 0 && age < 120000;
  } catch { return false; }
}
