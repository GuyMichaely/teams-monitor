import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { DATA_DIR } from '../src/local-paths.mjs';
import { parseYamlLogText, yamlLogDocument, yamlLogValue } from '../src/yaml-log.mjs';

function applicationLogFiles(dataDir) {
  const files = [];
  for (const base of [join(dataDir, 'activity.jsonl'), join(dataDir, 'gui-diagnostics.jsonl'), join(dataDir, 'agent', 'activity.jsonl')]) {
    for (const suffix of ['', '.1', '.2']) files.push(`${base}${suffix}`);
  }
  const addMatches = (directory, pattern) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) if (pattern.test(name)) files.push(join(directory, name));
  };
  addMatches(join(dataDir, 'lifecycle'), /^run-[\w-]+\.jsonl(?:\.[12])?$/);
  const supervisor = join(dataDir, 'supervisor');
  if (existsSync(supervisor)) for (const session of readdirSync(supervisor)) {
    if (!/^session-[\w-]+$/.test(session)) continue;
    const sessionDir = join(supervisor, session);
    if (!statSync(sessionDir).isDirectory()) continue;
    for (const suffix of ['', '.1', '.2']) files.push(join(sessionDir, `supervisor.jsonl${suffix}`));
    for (const run of readdirSync(sessionDir)) {
      if (!/^run-[0-9a-f-]+$/i.test(run)) continue;
      const runDir = join(sessionDir, run);
      if (statSync(runDir).isDirectory()) addMatches(runDir, /^run-[\w-]+\.jsonl(?:\.[12])?$/);
    }
  }
  return [...new Set(files)].filter(existsSync).sort();
}

function sameJson(a, b) {
  const canonical = value => {
    const normalized = yamlLogValue(value);
    const sort = item => Array.isArray(item) ? item.map(sort)
      : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
        : item;
    return JSON.stringify(sort(normalized));
  };
  return canonical(a) === canonical(b);
}

export function migrateLogFile(source) {
  if (!existsSync(source)) return { source, status: 'missing', records: 0 };
  const target = source.replace(/\.jsonl(?=\.[12]$|$)/, '.yaml');
  const backup = `${source}.migrated.bak`;
  const lines = readFileSync(source, 'utf8').split(/\r?\n/).filter(line => line.trim());
  const records = lines.map((line) => {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      return value;
    }
    catch { return { kind: 'invalid_log', error: 'Invalid log format', raw: line }; }
  });
  const expected = records.map(yamlLogDocument).join('');
  if (existsSync(target)) {
    const existing = parseYamlLogText(readFileSync(target, 'utf8'));
    if (existing.length !== records.length || !records.every((record, index) => sameJson(record, existing[index]))) {
      throw new Error(`Refusing divergent existing YAML log: ${basename(target)}`);
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.migration-${process.pid}.tmp`;
    try {
      writeFileSync(temporary, expected, { flag: 'wx' });
      const verify = parseYamlLogText(readFileSync(temporary, 'utf8'));
      if (verify.length !== records.length || !records.every((record, index) => sameJson(record, verify[index]))) {
        throw new Error(`YAML verification failed for ${basename(target)}`);
      }
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  }
  if (!existsSync(backup)) renameSync(source, backup);
  else if (existsSync(source)) throw new Error(`Source and backup both exist; refusing overwrite: ${basename(source)}`);
  return { source, target, status: 'migrated', records: records.length };
}

export function migrateLogFiles(dataDir = DATA_DIR) {
  const results = applicationLogFiles(dataDir).map(migrateLogFile);
  return { files: results.length, records: results.reduce((total, result) => total + result.records, 0), results };
}
