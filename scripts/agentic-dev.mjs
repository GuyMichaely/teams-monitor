import './agentic-dev-env.mjs';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { startPreview } from './agentic-preview.mjs';

// No real Teams, tunnel, phone, or copied credentials. Broker responses are fixtures.
process.env.AGENTIC_GUI_TOKEN ||= 'agentic-local';
const config = await loadConfig();
if (config.port === undefined) { config.port = 29222; await saveConfig(config); }
if (config.port !== 29222) throw Error('Development must use isolated mock Teams port 29222');
const gui = await startPreview(config);
console.log('Agentic development dashboard: http://127.0.0.1:28090 (mock Teams; no real sends).');
console.log('Use the development-only token agentic-local unless AGENTIC_GUI_TOKEN was supplied.');
let stop;
const done = new Promise(resolve => { stop = resolve; });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try { await gui.start(); await done; }
finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await gui.close(); }
