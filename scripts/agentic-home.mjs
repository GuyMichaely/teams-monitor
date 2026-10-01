import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function prepareAgenticHome(root) {
  const home = join(resolve(root), '.agentic-dev');
  const ownDirectory = path => {
    mkdirSync(path, { recursive: true });
    if (realpathSync(path).toLowerCase() !== path.toLowerCase()) throw new Error('Development directories must not be directory links.');
  };
  ownDirectory(home);
  for (const dir of ['config', 'context', 'data']) ownDirectory(join(home, dir));
  const configFile = join(home, 'config', 'config.yaml');
  if (!existsSync(configFile)) {
    const config = Bun.YAML.parse(readFileSync(join(root, 'config', 'config.example.yaml'), 'utf8'));
    config.gui = { port: 28090, host: '127.0.0.1', authTokenEnv: 'AGENTIC_GUI_TOKEN' };
    config.controlWorker = { enabled: false, publicHealthUrl: '' };
    config.desktop = { keepAwake: false };
    config.alerts.websocketUrl = 'http://127.0.0.1:28090/api/alerts';
    config.alerts.fcm = {};
    config.replyPolicy = { mode: 'whitelist', entries: [] };
    // Bootstrap only; later saves continue to use context.saveConfig.
    writeFileSync(configFile, Bun.YAML.stringify(config, null, 2), { flag: 'wx' });
  }
  const config = Bun.YAML.parse(readFileSync(configFile, 'utf8'));
  if (config?.gui?.port !== 28090 || config?.gui?.host !== '127.0.0.1' || config?.gui?.authTokenEnv !== 'AGENTIC_GUI_TOKEN')
    throw new Error('Development GUI must keep its separate loopback port and credentials.');
  const profile = join(home, 'context', 'user-profile.md');
  if (!existsSync(profile)) writeFileSync(profile, 'Development fixture. No real conversations or phone alerts.\n', { flag: 'wx' });
  return home;
}
