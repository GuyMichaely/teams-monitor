// Generates app/src/main/res/raw/alarm.wav
// 16-bit PCM mono, 22050 Hz: three ascending sine beeps (660/880/1100 Hz),
// 150ms each with 60ms gaps, the triplet repeated 3x (~1.9s total).
// Run: node tools/gen-alarm.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const BEEP_MS = 150;
const GAP_MS = 60;
const FREQS = [660, 880, 1100];
const REPEATS = 3;
const AMP = 0.85;

const beepLen = Math.floor(RATE * BEEP_MS / 1000);
const gapLen = Math.floor(RATE * GAP_MS / 1000);
const triplet = FREQS.length * (beepLen + gapLen);
const total = REPEATS * triplet + RATE / 4; // trailing silence
const samples = new Int16Array(total);

let pos = 0;
for (let r = 0; r < REPEATS; r++) {
  for (const f of FREQS) {
    for (let i = 0; i < beepLen; i++) {
      // short fade in/out to avoid clicks
      const edge = Math.min(i, beepLen - 1 - i, 200) / 200;
      samples[pos + i] = Math.round(Math.sin(2 * Math.PI * f * i / RATE) * AMP * edge * 32767);
    }
    pos += beepLen + gapLen;
  }
}

const dataLen = samples.length * 2;
const buf = Buffer.alloc(44 + dataLen);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataLen, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);        // fmt chunk size
buf.writeUInt16LE(1, 20);         // PCM
buf.writeUInt16LE(1, 22);         // mono
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 2, 28);  // byte rate
buf.writeUInt16LE(2, 32);         // block align
buf.writeUInt16LE(16, 34);        // bits per sample
buf.write('data', 36);
buf.writeUInt32LE(dataLen, 40);
for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);

const out = join(dirname(fileURLToPath(import.meta.url)), '../app/src/main/res/raw/alarm.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes, ${(samples.length / RATE).toFixed(2)}s)`);
