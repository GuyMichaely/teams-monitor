// One-time local trial setup. No process starts/stops and no production writes.
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, writeFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function initializeLiveTrial(productionRoot, agenticRoot) {
  const production = await realpath(productionRoot), agentic = await realpath(agenticRoot);
  if (production.toLowerCase() === agentic.toLowerCase()) throw Error('Trial and production must use separate folders.');
  for (const dir of ['config', 'context', 'data', 'data/desktop', 'automation']) {
    const path = resolve(agentic, dir);
    await mkdir(path, { recursive: true });
    if ((await realpath(path)).toLowerCase() !== path.toLowerCase()) throw Error('Trial directories must not be links to other folders.');
  }
  for (const relative of ['.env', 'config/config.yaml', 'config/fcm-service-account.json', 'context/user-profile.md', 'data/fcm-registration.json', 'automation/policy.ts']) {
    const path = join(agentic, relative);
    if (existsSync(path) && (await lstat(path)).isSymbolicLink()) throw Error('Trial setup files must not be links to production.');
  }
  const copied = [], preserved = [];
  const copy = async (source, relative, required = false) => {
    if (!existsSync(source)) { if (required) throw Error('A required production setup file is missing.'); return; }
    const destination = join(agentic, relative);
    if (existsSync(destination)) { preserved.push(relative); return; }
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    copied.push(relative);
  };
  const env = await readFile(join(production, '.env'), 'utf8');
  if (/^\s*(?:export\s+)?TEAMS_MONITOR_HOME\s*=/m.test(env)) throw Error('Production .env overrides the application home; separate local state must be configured first.');
  const config = Bun.YAML.parse(await readFile(join(production, 'config', 'config.yaml'), 'utf8'));
  const configFile = join(agentic, 'config', 'config.yaml');
  // Never reset an existing trial's settings or policy during shortcut rebuilds.
  if (!existsSync(configFile)) {
    const account = config.alerts?.fcm?.serviceAccountFile || 'config/fcm-service-account.json';
    await copy(isAbsolute(account) ? account : join(production, account), 'config/fcm-service-account.json');
    if (config.alerts?.fcm) config.alerts.fcm.serviceAccountFile = 'config/fcm-service-account.json';
    await writeFile(configFile, Bun.YAML.stringify(config, null, 2) + '\n', { flag: 'wx' });
    copied.push('config/config.yaml');
  } else preserved.push('config/config.yaml');
  await copy(join(production, '.env'), '.env', true);
  await copy(join(production, 'context', 'user-profile.md'), 'context/user-profile.md', true);
  await copy(join(production, 'data', 'fcm-registration.json'), 'data/fcm-registration.json');
  return { copied, preserved };
}

if (import.meta.main) {
  const agentic = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const production = process.argv[2];
  if (!production || process.argv.length !== 3) throw Error('Usage: bun run desktop:setup-switching <production-folder>');
  if (process.env.TEAMS_MONITOR_HOME) throw Error('Run setup without TEAMS_MONITOR_HOME.');
  if (execFileSync('git', ['branch', '--show-current'], { cwd: agentic, encoding: 'utf8' }).trim() !== 'agentic') throw Error('Run this setup from agentic, not production.');
  const result = await initializeLiveTrial(production, agentic);
  // Conversion and validation occur only against the trial copy; no model/effects run.
  const { ensurePolicy } = await import('../src/agent/policy.mjs');
  await ensurePolicy();
  execFileSync('powershell.exe', ['-NoProfile', '-File', join(agentic, 'scripts', 'install-desktop.ps1'), '-BuildOnly'], { cwd: agentic, windowsHide: true, stdio: 'inherit' });
  execFileSync('powershell.exe', ['-NoProfile', '-File', join(agentic, 'scripts', 'install-switch-shortcuts.ps1'), '-ProductionRoot', resolve(production)], { cwd: agentic, windowsHide: true, stdio: 'inherit' });
  console.log(JSON.stringify(result));
  console.log('Shortcuts ready. Quit the active TM tray before launching the other. Nothing was started or stopped.');
}
