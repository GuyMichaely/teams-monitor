import { join } from 'node:path';
import { DATA_DIR } from '../local-paths.mjs';
import { boundedYamlWriter } from '../process-diagnostics.mjs';

export const AGENT_ACTIVITY_FILE = join(DATA_DIR, 'agent', 'activity.yaml');
let write;
export function recordAgentActivity(event) {
  try {
    write ||= boundedYamlWriter(AGENT_ACTIVITY_FILE);
    write(event);
  } catch { /* Diagnostics must not change a run's result. */ }
}
