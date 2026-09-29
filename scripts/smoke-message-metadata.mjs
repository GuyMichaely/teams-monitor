import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { readOpenChatFromDocument } from "../src/teams.mjs";

class FakeElement {
  constructor(tagName, attrs = {}, text = "", children = []) {
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.text = text;
    this.children = children;
    for (const child of children) child.parent = this;
  }

  get innerText() {
    return this.text + this.children.map((child) => child.innerText).join("");
  }

  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      if (part.trim() === 'time') return this.tagName === 'TIME';
      const match = part.trim().match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      return match && this.attrs.has(match[1]) && (match[2] === undefined || this.attrs.get(match[1]) === match[2]);
    });
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector) || (selector === "time" && child.tagName === "TIME")) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  cloneNode() {
    return new FakeElement(this.tagName, Object.fromEntries(this.attrs), this.text, this.children.map((child) => child.cloneNode(true)));
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function message({ body = [], author = "Sender", time = "2026-09-24T12:00:00Z" } = {}) {
  return new FakeElement("div", { "data-tid": "chat-pane-message" }, "", [
    new FakeElement("span", { "data-tid": "message-author-name" }, author),
    new FakeElement("time", { datetime: time }),
    new FakeElement("div", { "data-message-content": "" }, "", body),
  ]);
}

const semanticMention = new FakeElement("span", { itemtype: "http://schema.skype.com/Mention" }, "Guy Michaely");
const doc = {
  querySelectorAll: (selector) => selector === '[data-tid="chat-pane-message"]' ? [
    message({ body: [new FakeElement("p", {}, "A plain @Guy and Guy text.")] }),
    message({ body: [new FakeElement("p", {}, "Hello "), semanticMention, new FakeElement("p", {}, "!")] }),
  ] : [],
};

const latest = readOpenChatFromDocument(doc, 1);
assert.equal(latest.length, 1);
assert.deepEqual(latest[0].mentions, ["Guy Michaely"]);
assert.equal(latest[0].author, "Sender");
assert.equal(latest[0].time, "2026-09-24T12:00:00Z");
assert.equal(latest[0].text, "Hello Guy Michaely!");
assert.deepEqual(readOpenChatFromDocument(doc, 2)[0].mentions, []);
assert.deepEqual(readOpenChatFromDocument(doc, 0), []);

const reacted = message({ body: [new FakeElement('p', {}, 'Actual message')] });
reacted.attrs.set('data-mid', '123');
const reaction = new FakeElement('div', { 'data-tid': 'diverse-reaction-summary' }, '', [
  new FakeElement('button', { 'data-tid': 'diverse-reaction-pill-button', 'aria-pressed': 'true' }, '2 Like reactions.\n2', [
    new FakeElement('img', { itemtype: 'http://schema.skype.com/Emoji', itemid: 'like', alt: '👍' }),
  ]),
]);
reaction.parent = reacted;
reacted.children.push(reaction);
const parsed = readOpenChatFromDocument({ querySelectorAll: () => [reacted] })[0];
assert.equal(parsed.id, '123');
assert.equal(parsed.text, 'Actual message', 'reaction UI must not change message body or dedupe');
assert.deepEqual(parsed.reactions, [{ key: 'like', emoji: '👍', count: 2, self: true }]);

console.log("✔ message metadata smoke passed");
