import { logYaml } from './dashboard-yaml.mjs';

// Shared card renderer for the global queue and a selected message's actions.
export function renderActionCards(records, filter = "all", now = Date.now()) {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stamp = (value) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  const stateOf = (item) => {
    if (item.state === "pending") return item.due && new Date(item.due).getTime() > now ? "Scheduled" : "Queued";
    if (item.state === "running") return "Running";
    return ({ completed: "Completed", cancelled: "Cancelled", failed: "Failed", missed: "Missed", uncertain: "Uncertain", blocked: "Blocked", superseded: "Superseded", invalid: "Invalid" })[item.state] || String(item.state || "Unknown");
  };
  const terminal = (state) => !["Scheduled", "Queued", "Running"].includes(state);
  const tone = (state) => state === "Completed" ? "good" : ["Failed", "Uncertain", "Invalid"].includes(state) ? "bad" : ["Missed", "Blocked", "Superseded"].includes(state) ? "warn" : state === "Running" ? "info" : "neutral";
  const presenceName = { available: 'Available', away: 'Appear away', offline: 'Appear offline', busy: 'Busy', dnd: 'Do not disturb', brb: 'Be right back' };
  const summary = (item) => {
    const value = item.value || {}, kind = value.kind;
    if (kind === 'status') return `Availability · ${presenceName[value.presence] || value.presence || 'Status change'}`;
    if (item.source === 'schedule' && kind === 'message') return `Scheduled message · ${value.chat || 'Teams chat'}`;
    if (kind === 'wake') return 'Wake' + (typeof value.prompt === 'string' ? ` · ${value.prompt.slice(0, 120)}` : '');
    if (kind === 'alert') return 'Phone alert' + (value.title ? ` · ${value.title}` : '');
    if (kind === 'message') return 'Message' + (value.chat ? ` · ${value.chat}` : '');
    return 'Invalid action format';
  };
  const filtered = (records || []).filter((item) => {
    const s = stateOf(item);
    return filter === "all" || filter === "pending" && ["Scheduled", "Queued"].includes(s) || filter === "running" && s === "Running" || filter === "finished" && terminal(s);
  });
  if (!filtered.length) return '<p class="hint action-empty">No actions in this view.</p>';
  return filtered.map((item) => {
    const state = stateOf(item), key = String(item.id || ""), details = { value: item.value, result: item.result };
    const hasDetail = item.value !== undefined || item.result !== undefined;
    const preview = item.value?.text || item.value?.body || item.value?.prompt;
    return `<article class="action-card" data-action-card="${esc(key)}"><div class="action-card-top"><strong>${esc(summary(item))}</strong><span class="badge ${tone(state)}">${esc(state)}</span></div>${preview ? `<p class="action-preview">${esc(String(preview).slice(0, 260))}</p>` : ""}${item.result?.message || item.result?.detail || item.error || item.detail ? `<p class="action-status">${esc(item.result?.message || item.result?.detail || item.error || item.detail)}</p>` : ""}<div class="action-meta">${item.source === 'schedule' ? 'Manual schedule · ' : ''}${esc(state === "Scheduled" || state === "Queued" ? "Due " + stamp(item.due) : "Created " + stamp(item.created))}</div><div class="action-controls">${item.messageId ? `<button class="small" data-action-message="${esc(item.messageId)}">View message</button>` : ""}${item.state === "pending" ? `<button class="small danger" data-action-cancel="${esc(key)}">Cancel</button>` : ""}${hasDetail ? `<details data-action-detail="${esc(key)}"><summary>Details</summary><pre>${esc(logYaml(details))}</pre></details>` : ""}</div></article>`;
  }).join("");
}
