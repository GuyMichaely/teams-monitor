import { join } from 'node:path';
import { DATA_DIR } from '../local-paths.mjs';
import { boundedWriter } from '../process-diagnostics.mjs';

export const AGENT_ACTIVITY_FILE = join(DATA_DIR, 'agent', 'activity.jsonl');
let write;
export function recordAgentActivity(event) {
  try {
    write ||= boundedWriter(AGENT_ACTIVITY_FILE);
    write(JSON.stringify(event) + '\n');
  } catch { /* Diagnostics must not change a run's result. */ }
}
