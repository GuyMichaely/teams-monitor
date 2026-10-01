import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAgenticHome } from './agentic-home.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const home = prepareAgenticHome(root);
process.env.TEAMS_MONITOR_HOME = home;
