import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./state.mjs";
import { appendYamlLog, readYamlLogTail } from './yaml-log.mjs';

export const DIAGNOSTICS_LOG = join(DATA_DIR, "gui-diagnostics.yaml");

export function tokenMatches(given, token) {
  if (!token) return true;
  const a = Buffer.from(given || "");
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authOk(header, token) {
  const m = /^Bearer\s+(.+)$/.exec(header || "");
  return !!m && tokenMatches(m[1], token);
}

export function requestMeta(req) {
  let path = "";
  try { path = new URL(req.url, "http://x").pathname; } catch { path = String(req.url || ""); }
  return {
    method: req.method || "",
    path,
    host: req.headers.host || "",
    origin: req.headers.origin || "",
    userAgent: req.headers["user-agent"] || "",
    cfConnectingIp: req.headers["cf-connecting-ip"] || "",
    cfRay: req.headers["cf-ray"] || "",
    xForwardedFor: req.headers["x-forwarded-for"] || "",
    remoteAddress: req.socket?.remoteAddress || "",
  };
}

export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/([?&]access_token=)[^&\s\"]+/gi, "$1<redacted>")
    .replace(/([?&]token=)[^&\s\"]+/gi, "$1<redacted>");
}

export function logDiagnostic(kind, data = {}) {
  try {
    appendYamlLog(DIAGNOSTICS_LOG, { at: new Date().toISOString(), kind, ...data });
  } catch { /* diagnostics must never break the server */ }
}

export function tailLines(path, limit = 120, maxBytes = 262_144) {
  if (!existsSync(path)) return [];
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (size > length) {
      const newline = text.indexOf('\n');
      if (newline < 0) return [];
      text = text.slice(newline + 1);
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-limit);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function tailYamlRecords(path, limit = 120, maxBytes = 262_144) {
  return readYamlLogTail(path, limit, maxBytes);
}
