import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../src/local-paths.mjs';
import { appendYamlLog, boundedYamlWriter, parseYamlLogText, readYamlLogTail, yamlLogDocument } from '../src/yaml-log.mjs';
import { migrateLogFiles } from './migrate-log-yaml.mjs';

const special = { at: '2026-10-04T12:00:00Z', omitted: undefined, array: [undefined, NaN], body: 'first\n---\nbody', nested: { yes: true }, value: null };
const normalized = JSON.parse(JSON.stringify(special));
const document = yamlLogDocument(special);
assert.match(document, /^---\n/);
assert.deepEqual(parseYamlLogText(document), [normalized]);
assert.equal(Object.hasOwn(parseYamlLogText(document)[0], 'omitted'), false);

const malformed = `---\nkind: good\n---\n: bad: :\n---\nkind: recovered\n`;
assert.deepEqual(parseYamlLogText(malformed).map(row => row.kind), ['good', 'invalid_log', 'recovered']);
assert.equal(parseYamlLogText('---\nnull\n---\n- array\n')[0].kind, 'invalid_log');

const boundedPath = join(DATA_DIR, `yaml-bounded-${randomUUID()}.yaml`);
const writer = boundedYamlWriter(boundedPath, 125, 2);
const first = { id: 1, text: 'short' }, second = { id: 2, text: 'a'.repeat(70) }, third = { id: 3, text: 'tail' };
writer(first); writer(second); writer(third);
assert.deepEqual(readYamlLogTail(boundedPath, 10).map(row => row.id), [3]);
assert.deepEqual(readYamlLogTail(`${boundedPath}.1`, 10).map(row => row.id), [1, 2]);
const oversizedPath = join(DATA_DIR, `yaml-oversized-${randomUUID()}.yaml`);
boundedYamlWriter(oversizedPath, 160, 1)({ kind: 'large', text: 'z'.repeat(500) });
const oversize = parseYamlLogText(readFileSync(oversizedPath, 'utf8'))[0];
assert.equal(oversize.kind, 'invalid_log');
assert.equal(oversize.error, 'Oversized log record truncated');
assert(statSync(oversizedPath).size <= 160);

const tailPath = join(DATA_DIR, `yaml-tail-${randomUUID()}.yaml`);
const bigRecord = { text: 'x'.repeat(100) };
writeFileSync(tailPath, yamlLogDocument({ id: 0, text: 'prefix'.repeat(30) }) + yamlLogDocument({ id: 1 }) + yamlLogDocument({ id: 2 }));
assert.deepEqual(readYamlLogTail(tailPath, 10, 50).map(row => row.id), [1, 2], 'partial first document is omitted from a bounded tail');
assert(bigRecord.text.length > 0);

const oldLog = join(DATA_DIR, 'activity.jsonl');
const originalRows = [{ at: '2026-10-01T00:00:00Z', kind: 'send', keep: null }, { at: '2026-10-02T00:00:00Z', kind: 'decision', value: 2 }];
writeFileSync(oldLog, originalRows.map(row => JSON.stringify(row)).join('\n') + '\n');
const migration = migrateLogFiles();
const backup = `${oldLog}.migrated.bak`;
assert(existsSync(backup));
const migratedPath = join(DATA_DIR, 'activity.yaml');
assert.deepEqual(parseYamlLogText(readFileSync(migratedPath, 'utf8')), originalRows);
assert(migration.files >= 1);
assert.deepEqual(migrateLogFiles().results.filter(result => result.source === oldLog).length, 0, 'retry ignores already-backed-up source');

const corrupted = join(DATA_DIR, 'agent', 'activity.jsonl');
mkdirSync(join(DATA_DIR, 'agent'), { recursive: true });
writeFileSync(corrupted, '{bad json}\n{"kind":"kept"}\n');
migrateLogFiles();
const recovered = parseYamlLogText(readFileSync(join(DATA_DIR, 'agent', 'activity.yaml'), 'utf8'));
assert.deepEqual(recovered[0], { kind: 'invalid_log', error: 'Invalid log format', raw: '{bad json}' });
assert.deepEqual(recovered[1], { kind: 'kept' });

const divergentSource = join(DATA_DIR, 'gui-diagnostics.jsonl');
writeFileSync(divergentSource, `${JSON.stringify({ kind: 'old' })}\n`);
writeFileSync(join(DATA_DIR, 'gui-diagnostics.yaml'), yamlLogDocument({ kind: 'different' }));
assert.throws(() => migrateLogFiles(), /Refusing divergent existing YAML log/);
assert(existsSync(divergentSource), 'divergent source remains intact');

appendYamlLog(join(DATA_DIR, 'append.yaml'), { kind: 'append' });
assert.equal(parseYamlLogText(readFileSync(join(DATA_DIR, 'append.yaml'), 'utf8'))[0].kind, 'append');
console.log('YAML audit log codec, recovery, bounded tails, whole-document rotation and guarded migration passed.');
