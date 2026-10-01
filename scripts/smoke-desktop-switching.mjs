import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DATA_DIR, ROOT } from '../src/local-paths.mjs';
import { initializeLiveTrial } from './setup-switching.mjs';

const base = await realpath(DATA_DIR);
const production = join(base, 'production folder'), agentic = join(base, 'trial folder');
for (const dir of ['config', 'context', 'data/desktop']) await mkdir(join(production, dir), { recursive: true });
await mkdir(agentic);
const config = { gui: { port: 8090 }, alerts: { fcm: { serviceAccountFile: join(production, 'config', 'account.json') } }, replyPolicy: { mode: 'whitelist', entries: [] }, automation: { rules: [] } };
const original = Bun.YAML.stringify(config);
await writeFile(join(production, 'config', 'config.yaml'), original);
await writeFile(join(production, 'config', 'account.json'), '{"project_id":"fixture"}');
await writeFile(join(production, '.env'), 'GUI_TOKEN=fixture-only\nGEMINI_API_KEY=fixture-only\n');
await writeFile(join(production, 'context', 'user-profile.md'), 'Fixture profile');
await writeFile(join(production, 'data', 'fcm-registration.json'), '{"fid":"fixture"}');
await writeFile(join(production, 'data', 'scheduled-actions.sqlite'), 'Must not copy');
await writeFile(join(production, 'data', 'heartbeat.json'), 'Must not copy');
await writeFile(join(production, 'data', 'orchestrator.log'), 'Must not copy');
await writeFile(join(production, 'data', 'desktop', 'TM.exe'), 'Never execute this test fixture');
const initialized = await initializeLiveTrial(production, agentic);
assert(initialized.copied.includes('.env'));
const trial = Bun.YAML.parse(await readFile(join(agentic, 'config', 'config.yaml'), 'utf8'));
assert.deepEqual(trial, { ...config, alerts: { fcm: { serviceAccountFile: 'config/fcm-service-account.json' } } });
assert.equal(await readFile(join(production, 'config', 'config.yaml'), 'utf8'), original);
assert.equal(await readFile(join(agentic, '.env'), 'utf8'), await readFile(join(production, '.env'), 'utf8'));
for (const file of ['scheduled-actions.sqlite', 'heartbeat.json', 'orchestrator.log']) assert(!existsSync(join(agentic, 'data', file)));
await writeFile(join(agentic, 'context', 'user-profile.md'), 'Trial edit');
assert((await initializeLiveTrial(production, agentic)).preserved.includes('context/user-profile.md'));
assert.equal(await readFile(join(agentic, 'context', 'user-profile.md'), 'utf8'), 'Trial edit');
await assert.rejects(initializeLiveTrial(production, production), /separate folders/);
const linked = join(DATA_DIR, 'linked trial'); await mkdir(linked);
await symlink(join(production, 'config'), join(linked, 'config'), process.platform === 'win32' ? 'junction' : 'dir');
await assert.rejects(initializeLiveTrial(production, linked), /must not be links/);

if (process.platform === 'win32') {
  const desktop = join(DATA_DIR, 'desktop fixture'); await mkdir(desktop);
  const script = join(ROOT, 'scripts', 'install-switch-shortcuts.ps1');
  const install = () => execFileSync('powershell.exe', ['-NoProfile', '-File', script, '-ProductionRoot', production, '-DesktopDirectory', desktop], { windowsHide: true, stdio: 'pipe' });
  install(); install();
  const quoted = path => "'" + path.replaceAll("'", "''") + "'";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $shell=New-Object -ComObject WScript.Shell; @(Get-ChildItem -LiteralPath ${quoted(desktop)} -Filter '*.lnk' | ForEach-Object { $s=$shell.CreateShortcut($_.FullName); [pscustomobject]@{Name=$_.BaseName;Target=$s.TargetPath;Arguments=$s.Arguments;Root=$s.WorkingDirectory} }) | ConvertTo-Json -Compress`], { windowsHide: true, encoding: 'utf8' });
  const shortcuts = JSON.parse(output);
  assert.equal(shortcuts.length, 2);
  assert.deepEqual(shortcuts.find(s => s.Name === 'TM — Prod'), { Name: 'TM — Prod', Target: join(production, 'data', 'desktop', 'TM.exe'), Arguments: '', Root: production });
  assert.deepEqual(shortcuts.find(s => s.Name === 'TM — Agentic'), { Name: 'TM — Agentic', Target: join(ROOT, 'data', 'desktop', 'TM.exe'), Arguments: '--agentic', Root: ROOT });
}
console.log('PASS: separate one-time trial settings/credentials, production preserved, no pending-state copy, link refusal, named shortcuts without process launch.');
