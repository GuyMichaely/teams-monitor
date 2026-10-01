import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { syncAgentRecordList } from '../src/dashboard-page.mjs';

// Minimal layout harness: exercise the browser's actual reconciliation function.
class Panel {
  children = []; clientTop = 1; clientHeight = 200; position = 0; text = '';
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get scrollHeight() { return this.children.reduce((total, node) => total + node.height, 0); }
  get scrollTop() { return Math.min(this.position, Math.max(0, this.scrollHeight - this.clientHeight)); }
  set scrollTop(value) { this.position = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight))); }
  set textContent(value) { this.text = value; for (const node of this.children) node.parent = null; this.children = []; }
  getBoundingClientRect() { return { top: 100 }; }
  insertBefore(node, cursor) {
    if (node.parent) node.remove();
    const index = cursor ? this.children.indexOf(cursor) : this.children.length;
    assert(index >= 0); this.children.splice(index, 0, node); node.parent = this;
  }
}
class Row {
  dataset = {}; details = { open: false }; parent = null; selectedText = false;
  constructor(height) { this.baseHeight = height; }
  get height() { return this.baseHeight + (this.details.open ? 80 : 0); }
  get nextElementSibling() { return this.parent.children[this.parent.children.indexOf(this) + 1] || null; }
  remove() { const p = this.parent; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parent = null; } }
  querySelector(selector) { assert.equal(selector, 'details'); return this.details; }
  getBoundingClientRect() {
    const p = this.parent;
    const offset = p.children.slice(0, p.children.indexOf(this)).reduce((sum, node) => sum + node.height, 0);
    const top = p.getBoundingClientRect().top + p.clientTop + offset - p.scrollTop;
    return { top, bottom: top + this.height };
  }
}
const panel = new Panel();
let created = 0;
const makeRow = record => { created++; return new Row(record.value.height); };
const record = (seq, height = 50) => ({ seq, kind: 'tool_result', at: seq, value: { height } });
let records = Array.from({ length: 20 }, (_, index) => record(20 - index));
const render = () => syncAgentRecordList(panel, structuredClone(records), makeRow);
const anchor = () => panel.children.find(node => node.getBoundingClientRect().bottom > 101);
render();
panel.scrollTop = 215;
const reading = anchor(), offset = reading.getBoundingClientRect().top;
reading.details.open = true; reading.selectedText = true;
render(); render();
assert.equal(panel.scrollTop, 215, 'Unchanged polls retain scroll');
assert.equal(created, 20, 'Unchanged polls reuse every DOM row');
assert.equal(anchor(), reading);
assert(reading.details.open && reading.selectedText, 'Open details/selected text remain on the original node');
records.unshift(record(21, 70));
render();
assert.equal(panel.scrollTop, 285, 'Prepending moves scroll by the new row height');
assert.equal(reading.getBoundingClientRect().top, offset, 'Reading stays at the same viewport position');
assert.equal(created, 21);
assert(reading.details.open && reading.selectedText);
records = records.slice(0, -2);
render();
assert.equal(reading.getBoundingClientRect().top, offset, 'Dropping old tail entries preserves retained anchor');
const readingIndex = records.findIndex(row => String(row.seq) === reading.dataset.recordKey);
records[readingIndex].kind = 'invalid_log';
render();
const updated = panel.children.find(row => row.dataset.recordKey === reading.dataset.recordKey);
assert.notEqual(updated, reading);
assert(updated.details.open, 'Updated content retains expanded detail state');
assert.equal(updated.getBoundingClientRect().top, offset);
panel.scrollTop = 0;
records.unshift(record(22, 90)); render();
assert.equal(panel.scrollTop, 0, 'Readers at newest stay at newest');
panel.scrollTop = 200;
records = Array.from({ length: 20 }, (_, index) => record(100 - index)); render();
assert.equal(panel.scrollTop, 200, 'An evicted anchor falls back to the numeric offset, not the top');
records = []; render();
assert.equal(panel.text, 'No agent activity recorded.');
assert.equal(panel.scrollTop, 0);
records = [record(200)]; render();
assert.equal(panel.childElementCount, 1);
assert.equal(panel.scrollTop, 0);
console.log('Agent result scroll smoke passed: unchanged polls, prepended results, retained/evicted anchors, open details, DOM reuse and empty transitions.');
