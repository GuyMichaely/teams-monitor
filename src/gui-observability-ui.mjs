// UI fragments for the orchestrator pipeline and connection diagnostics.
// Kept separate from the core dashboard so observability can evolve without
// making the zero-dependency HTTP/WebSocket server harder to read.

const PIPELINE_HTML = `
<style>
  .obs-live { display:inline-flex; align-items:center; gap:5px; margin-left:8px; color:var(--ok); font-size:11px; font-weight:600; letter-spacing:.04em; }
  .obs-live::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; box-shadow:0 0 0 3px rgba(63,185,80,.12); }
  .obs-live.paused { color:var(--dim); }
  .obs-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
  .obs-subtle { color:var(--dim); font-size:12px; }
  .pipeline { display:flex; flex-direction:column; gap:12px; }
  .flow { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .flow-head { padding:11px 13px; border-bottom:1px solid var(--line); background:#141820; }
  .flow-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .flow-title strong { font-size:14px; }
  .flow-message { margin-top:6px; white-space:pre-wrap; word-break:break-word; }
  .flow-stages { padding:7px 12px 10px; }
  .flow-stage { position:relative; padding:8px 8px 8px 30px; border-left:2px solid var(--line); margin-left:6px; }
  .flow-stage::before { content:""; position:absolute; left:-5px; top:15px; width:8px; height:8px; border-radius:50%; background:var(--dim); }
  .flow-stage:last-child { padding-bottom:3px; }
  .flow-stage.decision::before { background:var(--accent); }
  .flow-stage.effect.ok::before { background:var(--ok); }
  .flow-stage.effect.error::before, .flow-stage.error::before { background:var(--bad); }
  .flow-stage.effect.ignored::before { background:var(--dim); }
  .stage-top { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .stage-name { color:var(--dim); font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
  .stage-time { margin-left:auto; color:var(--dim); font-size:11px; }
  .stage-body { margin-top:4px; white-space:pre-wrap; word-break:break-word; }
  .action-badge { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; border:1px solid transparent; }
  .action-alarm, .action-escalate { color:#ff9a93; background:rgba(248,81,73,.12); border-color:rgba(248,81,73,.35); }
  .action-respond, .action-sent { color:#72d981; background:rgba(63,185,80,.12); border-color:rgba(63,185,80,.35); }
  .action-hold { color:#e6bd55; background:rgba(210,153,34,.12); border-color:rgba(210,153,34,.35); }
  .action-ignore, .action-ignored { color:#a9b0bc; background:rgba(139,147,161,.12); border-color:rgba(139,147,161,.3); }
  .action-error { color:#ff9a93; background:rgba(248,81,73,.12); border-color:rgba(248,81,73,.35); }
  .trace-details { margin-top:5px; }
  .trace-details summary { color:#aeb8c8; cursor:pointer; user-select:none; font-size:12px; }
  .trace-details pre { margin:7px 0 0; max-height:420px; white-space:pre-wrap; word-break:break-word; }
  .trace-label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin-top:8px; }
  .diag-summary { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:9px; }
  .diag-pill { border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:11px; color:var(--dim); background:#12161d; }
  .diag-pill.ok { color:#72d981; border-color:rgba(63,185,80,.35); }
  .diag-pill.bad { color:#ff9a93; border-color:rgba(248,81,73,.35); }
  .diag-events { display:flex; flex-direction:column; gap:5px; max-height:300px; overflow:auto; }
  .diag-event { display:grid; grid-template-columns:78px minmax(120px,170px) 1fr; gap:8px; padding:5px 7px; border-radius:6px; background:#12161d; font-size:12px; }
  .diag-event .when, .diag-event .detail { color:var(--dim); }
  .diag-event.good .kind { color:var(--ok); }
  .diag-event.bad .kind { color:var(--bad); }
  @media (max-width:650px) {
    .diag-event { grid-template-columns:68px 1fr; }
    .diag-event .detail { grid-column:1 / -1; }
    .stage-time { width:100%; margin-left:0; }
  }
</style>

<h2>Message pipeline <span id="pipelineLiveBadge" class="obs-live">LIVE · 2s</span></h2>
<div class="card">
  <div class="obs-toolbar">
    <div class="obs-subtle">Newest message flows first · expand model input/output for exact payloads</div>
    <div class="row">
      <button id="pipelineLiveButton" class="secondary" onclick="obsTogglePipelineLive()">Pause</button>
      <button class="secondary" onclick="obsRefreshPipeline(true)">Refresh</button>
    </div>
  </div>
  <div id="pipeline" class="pipeline"><span style="color:var(--dim)">No traced message flows yet.</span></div>
</div>
`;

const DIAGNOSTICS_HTML = `
<h2>Connection diagnostics <span id="diagnosticsLiveBadge" class="obs-live">LIVE · 2s</span></h2>
<div class="card">
  <div class="obs-toolbar">
    <div class="obs-subtle">Phone/tunnel connection events; this is now a live tail.</div>
    <div class="row">
      <button id="diagnosticsLiveButton" class="secondary" onclick="obsToggleDiagnosticsLive()">Pause</button>
      <button class="secondary" onclick="obsRefreshDiagnostics(true)">Refresh</button>
      <button class="secondary" onclick="obsCopyDiagnostics()">Copy diagnostics</button>
    </div>
  </div>
  <div id="diagnosticsSummary" class="diag-summary"></div>
  <div id="diagnosticsEvents" class="diag-events"><span style="color:var(--dim)">No diagnostics loaded.</span></div>
  <details class="trace-details" style="margin-top:10px">
    <summary>Raw diagnostics + Cloudflare tunnel logs</summary>
    <pre id="diagnosticsLog">(no diagnostics loaded)</pre>
  </details>
  <p style="color:var(--dim);font-size:12px;margin:8px 0 0">
    Authentication token values are redacted/not logged. Pause only affects this browser view; server-side logging continues.
  </p>
</div>
`;

const OBSERVABILITY_SCRIPT = `<script>
let obsPipelineLive = true;
let obsDiagnosticsLive = true;
let obsLatestDiagnostics = "";
let obsPipelineSignature = "";
const obsOpenTraceDetails = new Set();

function obsEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>\"]/g, function(c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c];
  });
}
function obsClock(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
}
function obsAgo(iso) {
  if (typeof ago === "function") return ago(iso);
  return obsClock(iso);
}
function obsJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function obsActionClass(action) {
  const a = String(action || "").toLowerCase();
  return "action-" + (["alarm","escalate","respond","sent","hold","ignore","ignored","error"].includes(a) ? a : "ignore");
}
function obsBadge(action) {
  return '<span class="action-badge ' + obsActionClass(action) + '">' + obsEscape(action || "unknown") + '</span>';
}
function obsDelta(at, startAt) {
  const n = Date.parse(at || "") - Date.parse(startAt || "");
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return "+" + n + "ms";
  return "+" + (n / 1000).toFixed(n < 10000 ? 1 : 0) + "s";
}
function obsDetail(key, summary, body) {
  return '<details class="trace-details" data-obs-key="' + obsEscape(key) + '"><summary>' + obsEscape(summary) + '</summary>' + body + '</details>';
}
function obsPre(label, value) {
  return '<div class="trace-label">' + obsEscape(label) + '</div><pre>' + obsEscape(value || "") + '</pre>';
}

function obsRenderStage(e, index, startAt) {
  const stage = e.stage || "event";
  const time = '<span class="stage-time">' + obsClock(e.at) + ' · ' + obsDelta(e.at, startAt) + '</span>';
  if (stage === "message") {
    return '<div class="flow-stage message"><div class="stage-top"><span class="stage-name">1 · picked up</span>' + time + '</div>' +
      '<div class="stage-body"><b>' + obsEscape(e.latest?.author || "?") + '</b>: ' + obsEscape(e.latest?.text || "") + '</div>' +
      '<div class="obs-subtle">history: ' + obsEscape(e.historyCount == null ? "?" : e.historyCount) + ' messages</div></div>';
  }
  if (stage === "brain_input") {
    let body = "";
    if (e.skipped) body = '<div class="stage-body obs-subtle">' + obsEscape(e.reason || "brain bypassed") + '</div>';
    else if (e.system != null || e.user != null) {
      body = obsDetail(e.flowId + ':brain-input:' + index, 'Show exact prompt sent to ' + (e.provider || "brain"),
        obsPre("System", e.system) + obsPre("User", e.user));
    } else {
      body = obsDetail(e.flowId + ':brain-input:' + index, 'Show rule-engine input', obsPre("Input", obsJson(e.input || {})));
    }
    const model = [e.provider, e.model].filter(Boolean).join(" · ");
    return '<div class="flow-stage brain-input"><div class="stage-top"><span class="stage-name">2 · brain input</span>' +
      (model ? '<span class="obs-subtle">' + obsEscape(model) + '</span>' : '') + time + '</div>' + body + '</div>';
  }
  if (stage === "brain_output") {
    return '<div class="flow-stage brain-output"><div class="stage-top"><span class="stage-name">3 · brain text output</span>' + time + '</div>' +
      obsDetail(e.flowId + ':brain-output:' + index, 'Show raw model output', obsPre("Raw output", e.raw || "")) + '</div>';
  }
  if (stage === "decision") {
    return '<div class="flow-stage decision"><div class="stage-top"><span class="stage-name">4 · decision</span>' + obsBadge(e.action) + time + '</div>' +
      '<div class="stage-body">' + obsEscape(e.reason || "") + '</div>' +
      (e.reply ? obsDetail(e.flowId + ':reply:' + index, 'Show proposed reply', obsPre("Reply", e.reply)) : '') + '</div>';
  }
  if (stage === "effect" || stage === "outcome") {
    const status = e.status || (e.outcome === "ignored" ? "ignored" : "ok");
    let detail = e.detail || e.reason || "";
    if (e.results) detail += (detail ? "\n" : "") + obsJson(e.results);
    if (e.result != null) detail += (detail ? "\n" : "") + obsJson(e.result);
    if (e.text) detail += (detail ? "\n" : "") + e.text;
    return '<div class="flow-stage effect ' + (status === "error" ? "error" : status === "ignored" ? "ignored" : "ok") + '"><div class="stage-top"><span class="stage-name">5 · effect</span>' +
      obsBadge(status === "error" ? "error" : (e.effect || e.outcome || status)) + time + '</div>' +
      (detail ? '<div class="stage-body">' + obsEscape(detail) + '</div>' : '') + '</div>';
  }
  if (stage === "error") {
    return '<div class="flow-stage error"><div class="stage-top"><span class="stage-name">error</span>' + obsBadge("error") + time + '</div><div class="stage-body">' + obsEscape(e.error || e.reason || "unknown error") + '</div></div>';
  }
  return '<div class="flow-stage"><div class="stage-top"><span class="stage-name">' + obsEscape(stage) + '</span>' + time + '</div><div class="stage-body">' + obsEscape(obsJson(e)) + '</div></div>';
}

function obsGroupFlows(items) {
  const map = new Map();
  for (const e of items) {
    if (e.kind !== "flow" || !e.flowId) continue;
    let flow = map.get(e.flowId);
    if (!flow) { flow = { id:e.flowId, events:[] }; map.set(e.flowId, flow); }
    flow.events.push(e);
  }
  const flows = Array.from(map.values());
  for (const f of flows) f.events.sort(function(a,b) { return Date.parse(a.at || 0) - Date.parse(b.at || 0); });
  flows.sort(function(a,b) {
    const aa = a.events.length ? a.events[a.events.length - 1].at : 0;
    const bb = b.events.length ? b.events[b.events.length - 1].at : 0;
    return Date.parse(bb || 0) - Date.parse(aa || 0);
  });
  return flows;
}
function obsRenderPipeline(items) {
  const root = document.getElementById("pipeline");
  if (!root) return;
  const flows = obsGroupFlows(items).slice(0, 60);
  if (!flows.length) {
    root.innerHTML = '<span style="color:var(--dim)">No traced message flows yet. New traces appear after the updated orchestrator processes a message.</span>';
    return;
  }
  root.innerHTML = flows.map(function(flow) {
    const message = flow.events.find(function(e) { return e.stage === "message"; });
    const decision = [...flow.events].reverse().find(function(e) { return e.stage === "decision"; });
    const first = message || flow.events[0];
    const chat = first?.chat || "?";
    const latest = message?.latest || {};
    const headBadge = decision ? obsBadge(decision.action) : '<span class="action-badge action-ignore">processing</span>';
    const stages = flow.events.map(function(e,i) { return obsRenderStage(e, i, first?.at); }).join("");
    return '<div class="flow"><div class="flow-head"><div class="flow-title"><strong>' + obsEscape(chat) + '</strong>' + headBadge +
      '<span class="obs-subtle">' + obsAgo(first?.at) + ' · ' + obsEscape(String(flow.id).slice(0,8)) + '</span></div>' +
      (message ? '<div class="flow-message"><b>' + obsEscape(latest.author || "?") + '</b>: ' + obsEscape(latest.text || "") + '</div>' : '') +
      '</div><div class="flow-stages">' + stages + '</div></div>';
  }).join("");
  root.querySelectorAll("details[data-obs-key]").forEach(function(d) {
    if (obsOpenTraceDetails.has(d.dataset.obsKey)) d.open = true;
  });
}
async function obsRefreshPipeline(force) {
  if (!force && !obsPipelineLive) return;
  try {
    const items = await tunnelApi("/api/activity?limit=500");
    const trace = items.filter(function(e) { return e.kind === "flow"; });
    const signature = trace.length + ':' + (trace[0]?.at || '') + ':' + (trace[0]?.flowId || '');
    if (force || signature !== obsPipelineSignature) {
      obsPipelineSignature = signature;
      obsRenderPipeline(items);
    }
  } catch (e) { if (force && typeof toast === "function") toast(e.message); }
}
function obsTogglePipelineLive() {
  obsPipelineLive = !obsPipelineLive;
  const badge = document.getElementById("pipelineLiveBadge");
  const button = document.getElementById("pipelineLiveButton");
  if (badge) { badge.textContent = obsPipelineLive ? "LIVE · 2s" : "PAUSED"; badge.classList.toggle("paused", !obsPipelineLive); }
  if (button) button.textContent = obsPipelineLive ? "Pause" : "Resume";
  if (obsPipelineLive) obsRefreshPipeline(true);
}

document.addEventListener("toggle", function(e) {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.obsKey) return;
  if (d.open) obsOpenTraceDetails.add(d.dataset.obsKey); else obsOpenTraceDetails.delete(d.dataset.obsKey);
}, true);

function obsDiagnosticClass(kind, event) {
  if (/rejected|error|disconnect/.test(kind || "") || Number(event?.statusCode) >= 400) return "bad";
  if (/connected|register|alert_http|started/.test(kind || "")) return "good";
  return "";
}
function obsDiagnosticDetail(e) {
  const bits = [];
  if (e.path) bits.push(e.path);
  if (e.statusCode) bits.push("HTTP " + e.statusCode);
  if (e.reason) bits.push(e.reason);
  if (e.durationMs != null) bits.push(e.durationMs + "ms");
  if (e.cfConnectingIp || e.remoteAddress) bits.push(e.cfConnectingIp || e.remoteAddress);
  if (e.error) bits.push(e.error);
  return bits.join(" · ");
}
function obsRenderDiagnostics(d) {
  obsLatestDiagnostics = JSON.stringify(d, null, 2);
  const pre = document.getElementById("diagnosticsLog");
  if (pre) pre.textContent = obsLatestDiagnostics;
  const events = Array.isArray(d.events) ? d.events : [];
  const latestWs = [...events].reverse().find(function(e) { return /^ws_/.test(e.kind || ""); });
  const latestFcm = [...events].reverse().find(function(e) { return e.kind === "fcm_register_http"; });
  const summary = document.getElementById("diagnosticsSummary");
  if (summary) {
    let wsText = "WebSocket: no events";
    let wsClass = "";
    if (latestWs) {
      if (latestWs.kind === "ws_connected") { wsText = "WebSocket: connected"; wsClass = "ok"; }
      else if (latestWs.kind === "ws_disconnected") { wsText = "WebSocket: disconnected"; wsClass = "bad"; }
      else if (latestWs.kind === "ws_rejected") { wsText = "WebSocket: rejected"; wsClass = "bad"; }
      else { wsText = "WebSocket: " + latestWs.kind.replace(/^ws_/, ""); }
    }
    const fcmOk = latestFcm && Number(latestFcm.statusCode) >= 200 && Number(latestFcm.statusCode) < 300;
    const fcmText = latestFcm ? "FCM registration: " + (fcmOk ? "OK" : "HTTP " + latestFcm.statusCode) : "FCM registration: no event";
    summary.innerHTML = '<span class="diag-pill ' + wsClass + '">' + obsEscape(wsText) + '</span>' +
      '<span class="diag-pill ' + (latestFcm ? (fcmOk ? "ok" : "bad") : "") + '">' + obsEscape(fcmText) + '</span>' +
      '<span class="diag-pill">server pid ' + obsEscape(d.serverPid || "?") + '</span>' +
      '<span class="diag-pill">updated ' + obsEscape(obsClock(d.generatedAt)) + '</span>';
  }
  const root = document.getElementById("diagnosticsEvents");
  if (root) {
    const recent = [...events].reverse().slice(0, 45);
    root.innerHTML = recent.length ? recent.map(function(e) {
      return '<div class="diag-event ' + obsDiagnosticClass(e.kind, e) + '"><span class="when">' + obsEscape(obsClock(e.at)) + '</span><span class="kind">' +
        obsEscape(e.kind || "event") + '</span><span class="detail">' + obsEscape(obsDiagnosticDetail(e)) + '</span></div>';
    }).join("") : '<span style="color:var(--dim)">No connection events recorded yet.</span>';
  }
}
async function obsRefreshDiagnostics(force) {
  if (!force && !obsDiagnosticsLive) return;
  try { obsRenderDiagnostics(await tunnelApi("/api/diagnostics?limit=160")); }
  catch (e) { if (force && typeof toast === "function") toast(e.message); }
}
function obsToggleDiagnosticsLive() {
  obsDiagnosticsLive = !obsDiagnosticsLive;
  const badge = document.getElementById("diagnosticsLiveBadge");
  const button = document.getElementById("diagnosticsLiveButton");
  if (badge) { badge.textContent = obsDiagnosticsLive ? "LIVE · 2s" : "PAUSED"; badge.classList.toggle("paused", !obsDiagnosticsLive); }
  if (button) button.textContent = obsDiagnosticsLive ? "Pause" : "Resume";
  if (obsDiagnosticsLive) obsRefreshDiagnostics(true);
}
async function obsCopyDiagnostics() {
  if (!obsLatestDiagnostics) await obsRefreshDiagnostics(true);
  try { await navigator.clipboard.writeText(obsLatestDiagnostics); if (typeof toast === "function") toast("Diagnostics copied"); }
  catch { if (typeof toast === "function") toast("Clipboard unavailable — select the raw diagnostics manually"); }
}

function obsHideLegacyFeeds() {
  document.querySelectorAll("h2").forEach(function(h) {
    const text = h.textContent.trim();
    if (text === "Escalations" || text === "Alarms" || text === "Recent activity") {
      h.style.display = "none";
      if (h.nextElementSibling) h.nextElementSibling.style.display = "none";
    }
  });
}
obsHideLegacyFeeds();
obsRefreshPipeline(true);
obsRefreshDiagnostics(true);
setInterval(function() { obsRefreshPipeline(false); obsRefreshDiagnostics(false); }, 2000);
</script>`;

export function injectObservability(page) {
  if (page.includes('id="pipeline"')) return page;
  return page
    .replace('  <h2>Brain context (user-profile.md)</h2>', PIPELINE_HTML + '\n  <h2>Brain context (user-profile.md)</h2>')
    .replace('</main>', DIAGNOSTICS_HTML + '\n</main>')
    .replace('</body>', OBSERVABILITY_SCRIPT + '\n</body>');
}
