// Explicit one-time migration; the application itself only reads YAML.
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { configYaml, parseConfigYaml } from '../src/config-format.mjs';

const exists = path => access(path).then(() => true, () => false);
export async function migrateConfig(directory) {
  const results = [];
  for (const name of ['config.example', 'config']) {
    const source = join(resolve(directory), name + '.json');
    const target = join(resolve(directory), name + '.yaml');
    const backup = source + '.migrated.bak';
    if (!await exists(source)) { results.push({ name, status: 'no JSON source' }); continue; }
    if (await exists(target) || await exists(backup)) throw new Error(`Refusing to overwrite migration target or backup for ${name}`);
    const original = JSON.parse(await readFile(source, 'utf8'));
    const yaml = configYaml(original);
    if (!isDeepStrictEqual(original, parseConfigYaml(yaml))) throw new Error(`YAML round-trip changed ${name}`);
    await writeFile(target, yaml, { flag: 'wx' });
    await rename(source, backup);
    results.push({ name, status: 'migrated', target, backup });
  }
  return results;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await migrateConfig(fileURLToPath(new URL('../config/', import.meta.url))));
}
