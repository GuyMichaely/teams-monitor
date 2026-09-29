import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, CONFIG_FILE } from '../src/local-paths.mjs';
import { loadConfig, saveConfig } from '../src/context.mjs';
import { parseConfigYaml, configYaml } from '../src/config-format.mjs';
import { migrateConfig } from './migrate-config-yaml.mjs';

const original = await loadConfig();
await saveConfig(original);
assert.deepEqual(await loadConfig(), original);
assert(CONFIG_FILE.endsWith('.yaml'));
const yaml = '# comment\nflag: false\nempty: []\nname: "1234"\ntext: |\n  first line\n  second line\n';
const parsed = parseConfigYaml(yaml);
assert.equal(parsed.flag, false); assert.equal(parsed.name, '1234');
assert.equal(parsed.text, 'first line\nsecond line\n');
assert.deepEqual(parseConfigYaml(configYaml(parsed)), parsed);
for (const invalid of ['', 'null', 'true', '- x', 'x: [', 'x: &a [*a]', 'x: .inf']) assert.throws(() => parseConfigYaml(invalid));
const temporary = await mkdtemp(join(DATA_DIR, 'migration-'));
for (const base of ['config', 'config.example']) await writeFile(join(temporary, base + '.json'), JSON.stringify(original));
assert((await migrateConfig(temporary)).every(r => r.status === 'migrated'));
for (const base of ['config', 'config.example']) {
  assert.deepEqual(parseConfigYaml(await readFile(join(temporary, base + '.yaml'), 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(join(temporary, base + '.json.migrated.bak'), 'utf8')), original);
  await assert.rejects(access(join(temporary, base + '.json')));
}
assert((await migrateConfig(temporary)).every(r => r.status === 'no JSON source'));
await writeFile(join(temporary, 'config.json'), '{}');
await assert.rejects(migrateConfig(temporary), /Refusing to overwrite/);
console.log('YAML parsing, atomic config save, exact migration/backups and overwrite refusal passed.');
