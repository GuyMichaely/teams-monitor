import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeSync, fsyncSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function yamlLogValue(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Log record must be JSON serializable');
  return JSON.parse(encoded);
}

export function yamlLogDocument(record) {
  return `---\n${Bun.YAML.stringify(yamlLogValue(record), null, 2)}\n`;
}

export function parseYamlLogText(text, { limit = Infinity } = {}) {
  if (limit <= 0) return [];
  const docs = String(text).split(/(?:^|\r?\n)---[\t ]*\r?\n/);
  const records = [];
  for (const source of docs) {
    if (!source.trim()) continue;
    try {
      const value = Bun.YAML.parse(source);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a log record mapping');
      records.push(value);
    } catch { records.push({ kind: 'invalid_log', error: 'Invalid log format' }); }
  }
  return Number.isFinite(limit) ? records.slice(-Math.max(0, limit)) : records;
}

export function appendYamlLog(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try { writeSync(fd, yamlLogDocument(record), null, 'utf8'); }
  finally { closeSync(fd); }
}

export function readYamlLogTail(path, limit = 120, maxBytes = 262_144) {
  if (!existsSync(path)) return [];
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // A tail that begins mid-document must never expose a fabricated partial record.
    if (size > length) {
      if (/^---[\t ]*\r?\n/.test(text)) return parseYamlLogText(text, { limit });
      const boundary = text.search(/\r?\n---[\t ]*\r?\n/);
      if (boundary < 0) return [];
      text = text.slice(boundary + (text[boundary] === '\r' ? 2 : 1));
    }
    return parseYamlLogText(text, { limit });
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function boundedYamlWriter(path, maxBytes = 256 * 1024, copies = 2) {
  mkdirSync(dirname(path), { recursive: true });
  let size = existsSync(path) ? statSync(path).size : 0;
  return (record, durable = false) => {
    let document = yamlLogDocument(record);
    let bytes = Buffer.byteLength(document);
    if (bytes > maxBytes) {
      const excerpt = document.slice(0, Math.max(0, Math.floor(maxBytes / 3)));
      const marker = { kind: 'invalid_log', error: 'Oversized log record truncated', originalKind: record?.kind, excerpt };
      document = yamlLogDocument(marker);
      while (Buffer.byteLength(document) > maxBytes && marker.excerpt.length) {
        marker.excerpt = marker.excerpt.slice(0, Math.floor(marker.excerpt.length / 2));
        document = yamlLogDocument(marker);
      }
      if (Buffer.byteLength(document) > maxBytes) throw new RangeError('maxBytes is too small for a YAML log marker');
      bytes = Buffer.byteLength(document);
    }
    // Rotate only between complete documents.
    if (size > 0 && size + bytes > maxBytes) {
      rmSync(`${path}.${copies}`, { force: true });
      for (let i = copies - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      if (existsSync(path)) renameSync(path, `${path}.1`);
      size = 0;
    }
    const fd = openSync(path, 'a');
    try { writeSync(fd, document, null, 'utf8'); if (durable) fsyncSync(fd); }
    finally { closeSync(fd); }
    size += bytes;
  };
}
