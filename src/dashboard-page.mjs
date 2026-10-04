import { buildActivityGroups } from "./dashboard-activity.mjs";
import { filterActivityAfter, parseActivityDate } from './activity-filter.mjs';

export function syncAgentRecordList(panel, rows, makeRow) {
  const previous = panel._agentRecordRows || new Map(), next = new Map();
  const scrollTop = panel.scrollTop, followNewest = scrollTop <= 1;
  const top = panel.getBoundingClientRect().top + panel.clientTop;
  const anchor = [...panel.children].find(node => node.getBoundingClientRect().bottom > top);
  const anchorKey = anchor?.dataset.recordKey, anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  if (!panel.childElementCount) panel.textContent = '';
  let cursor = panel.firstElementChild;
  for (const [index, record] of rows.entries()) {
    const key = String(record.seq ?? `invalid:${index}`), signature = JSON.stringify(record);
    const old = previous.get(key);
    const node = old?.signature === signature ? old.node : makeRow(record);
    node.dataset.recordKey = key;
    if (old && old.node !== node) {
      const details = node.querySelector('details');
      if (details) details.open = !!old.node.querySelector('details')?.open;
    }
    // Insert new entries without detaching unchanged rows or their selected text.
    if (node !== cursor) panel.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
    next.set(key, { node, signature });
  }
  while (cursor) { const after = cursor.nextElementSibling; cursor.remove(); cursor = after; }
  panel._agentRecordRows = next;
  if (!rows.length) panel.textContent = 'No agent activity recorded.';
  const retainedAnchor = next.get(anchorKey)?.node;
  if (followNewest) panel.scrollTop = 0;
  else if (retainedAnchor) panel.scrollTop += retainedAnchor.getBoundingClientRect().top - top - anchorOffset;
  else panel.scrollTop = scrollTop;
}

// One page owns presentation and refresh state; the existing authenticated APIs own controls.
function dashboardClient() {
  const $ = (id) => document.getElementById(id);
  function showPolicyFile(policy) {
    const link = $('policyFile');
    link.textContent = policy.path;
    link.href = policy.editorUrl;
    link.title = 'Open this file in VS Code on this computer';
  }
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const time = (at) => at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  const age = (at) => { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000)); return seconds < 60 ? seconds + "s ago" : seconds < 3600 ? Math.floor(seconds / 60) + "m ago" : Math.floor(seconds / 3600) + "h ago"; };
  const pretty = (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const badge = (text, tone = "neutral") => `<span class="badge ${tone}">${escape(text)}</span>`;
  let token = localStorage.guiToken || "";
  let overview, runtime, health, diagnostics, poll, tunnel;
  let presenceChanging = false, presenceRevision = 0;
  let keepAwakeSaving = false;
  let scheduleBusy = false, schedulesRefreshing = false, schedulesFingerprint = '', scheduleRequestId = null;
  let activitySaving = false, activityDirty = false, activityDateInvalid = false, activitySaveError = '', clearedThrough = null, activityGeneration = 0;
  let items = [], groups = [], selected = null, lastSuccess = null, paused = false, refreshing = false, slowAt = 0;
  let deliveryReady = false, policyReady = false, profileReady = false, agentPolicyReady = false;
  let deliveryDirty = false, policyDirty = false, profileDirty = false, pollDirty = false, rulesDirty = false;
  let agentBusy = false, agentRefreshing = false, agentStatus = null;
  let agentModeDirty = false, agentNoteDirty = false, agentNotePath = '', agentBriefDirty = false;
  let agentPermissionsDirty = false, agentPermissionsSaving = false, agentPermissionsRevision = 0;
  let sandboxDirty = false, sandboxSaving = false, sandboxRevision = 0;
  let listFingerprint = "", flowFingerprint = "";
  const failures = new Map();

  async function api(path, method = "GET", body) {
    const response = await fetch(path, { method, cache: "no-store", signal: AbortSignal.timeout(12000), headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401) {
      if (!$('login').open) { $('login').showModal(); $('tokenInput').focus(); }
      throw new Error("Sign in to connect to the dashboard.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed (" + response.status + ")");
    return result;
  }
  let toastTimer;
  function notify(message, error = false) {
    $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').className = 'toast hidden', 6000);
  }
  function status(id, text, tone) { $(id).textContent = text; $(id).className = "badge " + tone; }
  function setText(id, text) { $(id).textContent = text; }
  let supervisorBusy = false, supervisorCheckedAt = 0;
  async function refreshSupervisor() {
    if (supervisorBusy) return;
    if ($('login').open) {
      status('supervisorHealth', 'Sign in to check', 'neutral');
      return;
    }
    supervisorBusy = true;
    try {
      const value = await api('/api/supervisor/status');
      supervisorCheckedAt = Date.now();
      status('supervisorHealth', value.label, value.tone);
    } catch {
      supervisorCheckedAt = 0;
      status('supervisorHealth', 'Unavailable', 'warn');
    } finally { supervisorBusy = false; }
  }
  async function perform(button, work, message) {
    button.disabled = true;
    try { await work(); notify(message); slowAt = 0; await refresh(true); }
    catch (e) { notify(e.message, true); }
    finally { button.disabled = false; renderStatus(); }
  }
  function renderStatus() {
    if (runtime && !keepAwakeSaving) {
      $('keepAwake').checked = runtime.desktop?.keepAwake !== false;
      $('keepAwake').disabled = false;
    }
    const orch = overview?.orchestrator;
    if (orch) {
      status('orchStatus', orch.stale ? 'Not responding' : orch.running ? 'Running' : 'Stopped', orch.stale ? 'bad' : orch.running ? 'good' : 'neutral');
      $('startOrch').disabled = orch.running || orch.stale;
      $('stopOrch').disabled = !orch.running && !orch.stale;
      setText('orchDetail', orch.lastTickAt ? 'Last heartbeat ' + time(orch.lastTickAt) : 'No heartbeat recorded');
      if (!pollDirty) $('pollInterval').value = (overview.config.pollIntervalMs || 15000) / 1000;
    }
    if (tunnel) {
      status('tunnelStatus', tunnel.running ? 'Running' : 'Stopped', tunnel.running ? 'good' : 'neutral');
      $('startTunnel').disabled = tunnel.running; $('stopTunnel').disabled = !tunnel.running;
      setText('tunnelDetail', tunnel.hostname || 'Remote dashboard & WebSocket connection');
    }
    if (!runtime || !health || !diagnostics) return;
    const fcm = diagnostics.alertDelivery?.fcm || {};
    const delivery = diagnostics.alertDelivery?.delivery || {};
    const primary = runtime.alerts.transport;
    const fcmConfigured = runtime.alerts.fcmServiceAccountValid && runtime.alerts.fcmProjectId;
    const fcmReady = fcmConfigured && fcm.registrationPresent && fcm.registrationStatus !== 'suspect';
    const wsReady = health.websocketClients > 0;
    const ready = primary === 'fcm' ? fcmReady : wsReady;
    const degraded = delivery.state !== 'primary_working';
    const phoneTitle = !ready ? (primary === 'fcm' ? (!fcmConfigured ? 'Firebase setup required' : !fcm.registrationPresent ? 'Open the phone app to register' : 'Phone registration needs recovery') : 'Waiting for the phone to connect') : degraded ? 'Primary recovering' : primary === 'fcm' ? 'Ready to send · receipt unverified' : 'Phone connected';
    status('phoneHealth', ready && !degraded ? 'Ready' : 'Needs attention', ready && !degraded ? 'good' : 'warn');
    setText('deliveryHint', phoneTitle);
    setText('activeTransport', 'Active: ' + (delivery.activeTransport === 'fcm' ? 'FCM push' : 'WebSocket') + ' · ' + (delivery.state || 'unknown').replaceAll('_', ' '));
    status('teamsHealth', health.teams.connected ? 'Connected' : 'Not connected', health.teams.connected ? 'good' : 'neutral');
    status('brainHealth', health.brain.configured ? 'Configured' : 'Missing API key', health.brain.configured ? 'good' : 'warn');
    setText('brainModel', health.brain.model || health.brain.provider);
    status('wsHealth', wsReady ? health.websocketClients + ' connected' : 'No connection', wsReady ? 'good' : 'neutral');
    const t = health.tunnel;
    const staleTunnel = !t?.checkedAt || Date.now() - Date.parse(t.checkedAt) > 180000;
    status('publicHealth', staleTunnel ? 'Not checked recently' : t.reachable ? 'Reachable' : 'Unreachable', staleTunnel ? 'neutral' : t.reachable ? 'good' : 'warn');
    const issues = [];
    if (!ready) issues.push(phoneTitle + '.');
    if (orch?.stale) issues.push('The orchestrator process is alive but its heartbeat is stale.');
    if (!health.brain.configured) issues.push('Configure the brain API key before monitoring.');
    $('attention').hidden = !issues.length; setText('attentionText', issues.join(' '));
    $('setupDetails').innerHTML = `<dl class="facts"><dt>Firebase project</dt><dd>${escape(runtime.alerts.fcmProjectId || 'Not configured')}</dd><dt>PC credentials</dt><dd>${runtime.alerts.fcmServiceAccountValid ? 'Present' : 'Missing or invalid'}</dd><dt>Phone registration</dt><dd>${escape(fcm.registrationPresent ? (fcm.registrationKind || 'registered') + ' · generation ' + fcm.registrationGeneration : 'Not registered')}</dd><dt>Last FCM send accepted</dt><dd>${escape(time(fcm.lastSuccessAt))}</dd><dt>Retry after</dt><dd>${escape(time(fcm.nextAttemptAt))}</dd></dl>` + (fcm.lastError ? `<p class="error-text">${escape(fcm.lastError)}</p>` : '');
  }
  function renderPoll() {
    const running = overview?.orchestrator?.running;
    const stale = overview?.orchestrator?.stale;
    const active = poll && !poll.completedAt && running;
    status('pollBadge', stale ? 'Stale' : active ? 'Polling' : running ? 'Waiting' : 'Stopped', stale ? 'warn' : running ? 'good' : 'neutral');
    setText('pollStatus', active ? (poll.stage || 'Polling') : poll?.completedAt ? 'Last poll ' + (poll.errors ? 'finished with errors ' : 'completed ') + age(poll.completedAt) : 'No poll recorded yet');
    setText('pollDetail', active && poll.currentChat ? poll.currentChat : poll?.startedAt ? time(poll.startedAt) + (poll.durationMs != null ? ' · ' + (poll.durationMs / 1000).toFixed(1) + 's duration' : '') : 'Start the orchestrator to see live activity here.');
    for (const [id, field] of [['pollChats', 'targets'], ['pollHandled', 'handled'], ['pollDuplicates', 'duplicates'], ['pollErrors', 'errors']]) setText(id, poll?.[field] ?? '—');
    setText('pollNext', running && poll?.nextPollAt && !active ? (Date.now() < Date.parse(poll.nextPollAt) ? 'Next poll in ' + Math.ceil((Date.parse(poll.nextPollAt) - Date.now()) / 1000) + 's' : 'Next poll due') : active ? 'Processing' : 'Monitor stopped');
    setText('pollExtra', poll ? `${poll.examined} chats examined · ${poll.skipped} skipped${poll.error ? ' · ' + poll.error : ''}` : 'Counts will appear after the first poll.');
  }
  function groupMessages() { groups = buildActivityGroups(filterActivityAfter(items, clearedThrough)); }
  function outcome(group) {
    if (group.invalid) return ['Invalid log format', 'bad'];
    if (group.error) return ['Error', 'bad'];
    if (group.events.length && !group.done) return ['In progress / incomplete', 'info'];
    if (group.outcomes?.includes('alarm')) return [group.outcomes.includes('reply') ? 'Alerted · Replied' : 'Alerted', 'warn'];
    if (group.outcomes?.includes('reply')) return ['Replied', 'good'];
    if (group.outcomes?.includes('ignore')) return ['No action', 'neutral'];
    return ['Recorded', 'neutral'];
  }
  function renderMessages(force = false) {
    const query = $('searchMessages').value.toLowerCase();
    const filter = $('messageFilter').value;
    const filtered = groups.filter((g) => (!query || [g.chat, g.latest?.author, g.latest?.text].join(' ').toLowerCase().includes(query)) && (filter === 'all' || (filter === 'error' ? g.error : g.outcomes?.includes(filter))));
    if (!filtered.some(g => g.id === selected)) selected = filtered[0]?.id || null;
    renderDateFilter();
    setText('messageCount', filtered.length + (filtered.length === 1 ? ' message' : ' messages'));
    const fingerprint = JSON.stringify([filtered, selected]);
    const selection = window.getSelection();
    if (!force && !selection?.isCollapsed && $('messages').contains(selection?.anchorNode)) return;
    if (!force && fingerprint === listFingerprint) return;
    listFingerprint = fingerprint;
    $('messages').innerHTML = filtered.length ? filtered.map((g) => {
      const [label, tone] = outcome(g);
      const icons = g.icons.map(i => `<span class="action-icon" role="img" aria-label="${escape(i.label)}" title="${escape(i.label)}">${i.symbol}</span>`).join('');
      return `<article class="message ${g.id === selected ? 'selected' : ''} ${g.error ? 'message-error' : ''}" data-flow="${escape(g.id)}" tabindex="0" aria-label="${escape(g.chat)} message" aria-current="${g.id === selected}"><div class="message-top"><strong>${escape(g.chat || 'Unknown chat')}</strong><span class="action-icons">${icons}</span></div><div class="message-author">${escape(g.latest?.author || (g.invalid ? 'Invalid log format' : 'Unknown author'))}</div><p class="message-copy">${escape(g.latest?.text || (g.invalid ? 'Invalid log format' : ''))}</p><div class="message-meta">${badge(label, tone)}<time>${escape(time(g.at))}</time></div></article>`;
    }).join('') : '<div class="empty"><span class="empty-icon">◎</span><h3>No messages to show</h3><p>New messages appear as the orchestrator reads them. Try clearing your filters.</p></div>';
  }
  function renderFlow(force = false) {
    const group = groups.find((g) => g.id === selected);
    const fingerprint = JSON.stringify(group);
    if (!force && fingerprint === flowFingerprint) return;
    flowFingerprint = fingerprint;
    const open = [...$('pipeline').querySelectorAll('details[open]')].map((d) => d.dataset.key);
    if (!group) { $('pipeline').innerHTML = '<div class="empty"><span class="empty-icon">⋮</span><h3>Message details</h3><p>Select a message to see what the system read, what the brain decided, and what happened next.</p></div>'; return; }
    if (group.invalid) { $('pipeline').innerHTML = '<div class="empty"><h3>Invalid log format</h3><p>This entry is missing a valid message or handling trace. The diagnostic log remains available.</p></div>'; return; }
    const names = { message: 'Message received', policy: 'Reply permissions checked', brain_input: 'Sent to the brain', brain_output: 'Brain responded', decision: 'Decision made', effect: 'Action result', error: 'Handling failed' };
    const stages = group.events;
    $('pipeline').innerHTML = `<div class="flow-intro"><div class="eyebrow">HANDLING TRACE</div><h3>${escape(group.chat)}</h3><p>${escape(group.latest?.author || '')} · ${escape(time(group.at))}</p>${badge(...outcome(group))}</div>` + (stages.length ? `<ol class="timeline">${stages.map((event, index) => {
      const seconds = ((Date.parse(event.at) - Date.parse(group.at)) / 1000).toFixed(1);
      const key = event.stage + ':' + index;
      const body = event.stage === 'message' ? event.latest?.text : event.reason || event.error || event.detail || (event.stage === 'brain_input' ? [event.provider, event.model].filter(Boolean).join(' · ') : event.stage === 'brain_output' ? 'Model response captured' : event.effect?.replaceAll('_', ' ') || '');
      const details = event.stage === 'brain_input' ? { system: event.system, user: event.user, input: event.input, skipped: event.skipped } : event.stage === 'brain_output' ? event.raw : event.ruleActions || event.ruleEvaluations || event.results || event.reply || event.result;
      return `<li class="stage ${event.stage === 'error' || event.status === 'error' ? 'failed' : ''}"><span class="stage-dot">${index + 1}</span><div class="stage-title"><strong>${escape(event.source === 'javascript' ? 'JavaScript policy' : event.source === 'rules' ? 'Configured rules evaluated' : event.source === 'rule_review' ? 'LLM review failed · configured actions retained' : names[event.stage] || event.stage)}</strong><span>+${escape(seconds)}s</span></div><time>${escape(time(event.at))}</time>${event.action ? badge(event.action) : ''}<p>${escape(body)}</p>${details ? `<details data-key="${escape(key)}" ${open.includes(key) ? 'open' : ''}><summary>${event.stage === 'brain_input' ? 'View exact brain input' : 'View details'}</summary><pre>${escape(pretty(details))}</pre></details>` : ''}</li>`;
    }).join('')}</ol>` : '<div class="empty"><p>Invalid log format</p></div>') + (!group.done && stages.length ? '<p class="trace-note">No completed action is recorded in this log window. New stages appear here while live updates are on.</p>' : '');
  }
  function renderLogs(lines) {
    setText('orchestratorLog', lines?.lines?.join('\n') || 'No orchestrator output yet.');
    setText('connectionLog', diagnostics?.events?.slice().reverse().map((e) => `${time(e.at)}  ${e.kind}\n${pretty(e)}`).join('\n\n') || 'No connection events yet.');
    setText('tunnelLog', [...(diagnostics?.tunnelLog || []), ...(diagnostics?.tunnelOutLog || [])].join('\n') || 'No tunnel output in the standard log yet.');
    setText('activityLog', items.slice(0, 120).map((e) => `${time(e?.at)}  ${e?.kind || 'Invalid log format'}${e?.stage ? ' / ' + e.stage : ''}\n${pretty(e)}`).join('\n\n') || 'No recorded activity.');
  }
  async function readPart(name, path, assign) {
    try { assign(await api(path)); failures.delete(name); }
    catch (e) { failures.set(name, e.message); }
  }
  let logData;
  async function refresh(force = false) {
    if (refreshing || (paused && !force) || $('login').open) return;
    refreshing = true;
    const generation = activityGeneration;
    const presenceVersion = presenceRevision;
    try {
      await Promise.all([
        readPart('Monitor', '/api/overview', (v) => overview = v),
        readPart('Poll', '/api/poll', (v) => poll = v),
        readPart('Messages', '/api/activity?limit=500&unfiltered=1', (v) => { items = v; }),
        readPart('Activity view', '/api/activity/view', (v) => { if (generation === activityGeneration && !activityDirty && !activitySaving) clearedThrough = v.clearedThrough; }),
      ]);
      groupMessages();
      if (force || Date.now() - slowAt > 10000) {
        slowAt = Date.now();
        await Promise.all([
          readPart('Runtime', '/api/runtime/config', (v) => { runtime = v; if (!deliveryDirty) { $('deliveryMethod').value = v.alerts.transport; $('fallbackEnabled').checked = !!v.alerts.fallbackTransport; deliveryReady = true; } }),
          readPart('Tunnel', '/api/tunnel/status', (v) => tunnel = v),
          readPart('Health', '/api/health/status', (v) => health = v),
          presenceChanging ? null : readPart('Teams status', '/api/teams/presence', (v) => {
            if (presenceVersion !== presenceRevision || presenceChanging) return;
            $('presenceSelect').value = v.value || '';
            setText('presenceLabel', v.connected ? 'Set status' : 'Set status · Teams not connected');
            $('presenceSelect').title = v.status || 'Teams not connected';
          }),
          readPart('Diagnostics', '/api/diagnostics?limit=100', (v) => diagnostics = v),
          readPart('Logs', '/api/log?limit=200', (v) => logData = v),
        ]);
      }
      await Promise.all([
        policyReady ? null : readPart('Reply policy', '/api/reply-policy', (v) => { if (!policyDirty) { $('replyMode').value = v.mode; $('replyEntries').value = v.entries.join('\n'); } policyReady = true; policySummary(); }),
        profileReady ? null : readPart('Brain context', '/api/profile', (v) => { if (!profileDirty) $('brainContext').value = v.text; profileReady = true; }),
        agentPolicyReady ? null : readPart('JavaScript policy', '/api/agent/policy', (v) => { showPolicyFile(v); if (!rulesDirty) $('alertRules').value = v.source; agentPolicyReady = true; $('ruleFields').disabled = false; }),
      ]);
      renderStatus(); renderPoll(); renderMessages(); renderFlow(); renderLogs(logData);
      $('connectionError').hidden = !failures.size;
      setText('connectionError', [...failures].map(([name, error]) => name + ': ' + error).join(' · '));
      if (!failures.size) lastSuccess = new Date().toISOString();
      updateLiveLabel();
    } finally { refreshing = false; }
  }
  function updateLiveLabel() {
    const state = paused ? 'Paused' : failures.size ? 'Reconnecting' : lastSuccess ? 'Live' : 'Connecting';
    const button = $('pauseUpdates');
    button.className = 'live-toggle ' + (paused ? 'neutral' : failures.size || !lastSuccess ? 'warn' : 'good');
    button.textContent = paused ? 'Resume live log tailing' : (state === 'Live' ? '' : state + ' · ') + 'Pause live log tailing';
    button.title = state + ' · ' + (paused ? 'Resume live log tailing' : 'Pause live log tailing');
    button.setAttribute('aria-pressed', String(!paused));
    setText('lastRefresh', lastSuccess ? 'Synced ' + time(lastSuccess) : 'Waiting for server');
  }
  function policySummary() {
    const entries = $('replyEntries').value.split('\n').map((v) => v.trim()).filter(Boolean);
    const whitelist = $('replyMode').value === 'whitelist';
    setText('policyHint', whitelist ? entries.length ? `Only these ${entries.length} chat${entries.length === 1 ? '' : 's'} may receive Teams replies.` : 'Empty whitelist: nobody may receive Teams replies.' : entries.length ? 'Teams replies are allowed in every chat except those listed.' : 'Empty blacklist: Teams replies are allowed in every chat.');
    $('policyHint').className = 'hint ' + (!whitelist ? 'warning-text' : '');
  }
  $('loginForm').addEventListener('submit', (event) => {
    event.preventDefault(); token = $('tokenInput').value.trim(); localStorage.guiToken = token; $('login').close(); slowAt = 0; refresh(true);
  });
  $('accountButton').onclick = () => { $('login').showModal(); $('tokenInput').focus(); };
  $('login').addEventListener('cancel', (e) => e.preventDefault());
  $('pauseUpdates').onclick = () => { paused = !paused; updateLiveLabel(); if (!paused) refresh(true); };
  $('refreshButton').onclick = () => { refresh(true); refreshSupervisor(); };
  function localDateTime(at) { const d = new Date(at); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, -1); }
  const scheduleNames = { available: 'Available', away: 'Appear away', offline: 'Appear offline', busy: 'Busy', dnd: 'Do not disturb', brb: 'Be right back' };
  function renderSchedules(jobs) {
    const fingerprint = JSON.stringify(jobs);
    if (schedulesFingerprint === fingerprint) return;
    schedulesFingerprint = fingerprint;
    const row = job => {
      const tone = job.state === 'completed' ? 'good' : ['failed','uncertain','invalid'].includes(job.state) ? 'bad' : ['missed','blocked','superseded'].includes(job.state) ? 'warn' : 'neutral';
      return `<article class="schedule-job"><div class="inline-heading"><strong>${escape(job.kind === 'message' ? 'Message · ' + job.chat : job.kind === 'status' ? 'Status · ' + scheduleNames[job.presence] : 'Invalid schedule')}</strong>${badge(job.state, tone)}</div><time>${escape(time(job.dueAt))}</time>${job.kind === 'message' ? `<p class="scheduled-text">${escape(job.text)}</p>` : ''}<p class="hint">${escape(job.detail)}</p>${job.state === 'pending' ? `<button class="small danger" data-cancel-schedule="${escape(job.id)}">Cancel</button>` : ''}</article>`;
    };
    $('schedulePending').innerHTML = jobs.filter(j => ['pending','running'].includes(j.state)).map(row).join('') || '<p class="hint">No pending schedules.</p>';
    $('scheduleHistory').innerHTML = jobs.filter(j => !['pending','running'].includes(j.state)).map(row).join('') || '<p class="hint">No completed schedules.</p>';
  }
  async function refreshSchedules() {
    if (schedulesRefreshing || scheduleBusy || $('login').open) return;
    schedulesRefreshing = true;
    try {
      const data = await api('/api/schedules'); renderSchedules(data.jobs);
      setText('schedulerState', data.orchestrator?.running && !data.orchestrator?.stale ? 'Orchestrator running' : 'Orchestrator stopped or not responding · schedules cannot run');
      $('scheduleSubmit').disabled = false; setText('scheduleLoadState', '');
    } catch (e) { setText('scheduleLoadState', e.message); }
    finally { schedulesRefreshing = false; }
  }
  function scheduleKindChanged() {
    const message = $('scheduleKind').value === 'message';
    $('scheduleMessageFields').hidden = !message;
    $('scheduleChat').required = message; $('scheduleText').required = message;
    $('scheduleStatusField').hidden = message;
  }
  $('scheduleKind').onchange = scheduleKindChanged;
  $('scheduleForm').oninput = () => { scheduleRequestId = null; };
  $('scheduleWhen').value = localDateTime(Date.now() + 10 * 60000).slice(0, 16);
  setText('scheduleTimezone', 'Time zone: ' + Intl.DateTimeFormat().resolvedOptions().timeZone);
  scheduleKindChanged();
  $('scheduleForm').onsubmit = async e => {
    e.preventDefault(); if (scheduleBusy) return;
    const raw = $('scheduleWhen').value, due = new Date(raw);
    if (!Number.isFinite(due.getTime()) || due.getTime() <= Date.now() || localDateTime(due).slice(0,16) !== raw) {
      notify('Choose a valid future local date/time. Times skipped by daylight saving are not accepted.', true); return;
    }
    scheduleRequestId ||= crypto.randomUUID();
    const body = { kind: $('scheduleKind').value, dueAt: due.toISOString(), requestId: scheduleRequestId,
      chat: $('scheduleChat').value, text: $('scheduleText').value, presence: $('schedulePresence').value };
    scheduleBusy = true; $('scheduleFields').disabled = true; $('scheduleSubmit').disabled = true;
    try {
      await api('/api/schedules', 'POST', body); scheduleRequestId = null;
      if (body.kind === 'message') $('scheduleText').value = ''; notify('Schedule saved');
    } catch (e) { notify(e.message + ' Your draft was kept.', true); }
    finally { scheduleBusy = false; $('scheduleFields').disabled = false; await refreshSchedules(); }
  };
  $('schedulePending').onclick = async e => {
    const button = e.target.closest('[data-cancel-schedule]');
    if (!button || scheduleBusy) return;
    if (button.dataset.confirmed !== 'true') {
      button.dataset.confirmed = 'true'; button.textContent = 'Confirm cancel';
      setTimeout(() => { button.dataset.confirmed = ''; button.textContent = 'Cancel'; }, 10000);
      return;
    }
    button.disabled = true; scheduleBusy = true;
    try { await api('/api/schedules/' + button.dataset.cancelSchedule + '/cancel', 'POST'); notify('Schedule cancelled'); }
    catch (e) { notify(e.message, true); }
    finally { scheduleBusy = false; button.disabled = false; await refreshSchedules(); }
  };
  $('refreshSchedules').onclick = refreshSchedules;
  function syncDateFilter() { $('activitySince').value = clearedThrough ? localDateTime(clearedThrough) : ''; }
  function renderDateFilter() {
    const at = groups.find(g => g.id === selected)?.at;
    $('clearActivity').disabled = !at || !Number.isFinite(Date.parse(at));
    $('showAllActivity').disabled = !clearedThrough && !activityDateInvalid && !activitySaveError;
    if (!activityDateInvalid && document.activeElement !== $('activitySince')) syncDateFilter();
    $('activitySince').setAttribute('aria-invalid', String(activityDateInvalid));
    setText('activityClearState', activityDateInvalid ? 'Invalid date — keeping the last valid filter.' : activitySaveError ? 'Filter not saved — edit the date to retry.' : activitySaving ? 'Saving…' : '');
  }
  async function saveActivityView() {
    if (activitySaving) return;
    activitySaving = true; renderDateFilter();
    try {
      while (activityDirty) {
        const generation = activityGeneration, through = clearedThrough;
        try {
          await api('/api/activity/view', 'PUT', { through });
          if (generation === activityGeneration) {
            activityDirty = false; activityGeneration++; activitySaveError = '';
          }
        } catch (e) {
          if (generation !== activityGeneration) continue;
          activitySaveError = e.message; notify(e.message, true); break;
        }
      }
    } finally { activitySaving = false; renderDateFilter(); }
  }
  function changeActivityView(through) {
    activityDateInvalid = false; activitySaveError = '';
    if (through === clearedThrough && !activityDirty) { renderDateFilter(); return; }
    clearedThrough = through; activityDirty = true; activityGeneration++;
    groupMessages(); renderMessages(true); renderFlow(true);
    saveActivityView();
  }
  $('clearActivity').onclick = () => {
    const at = groups.find(g => g.id === selected)?.at;
    if (at && Number.isFinite(Date.parse(at))) {
      $('activitySince').value = localDateTime(at); changeActivityView(new Date(at).toISOString());
    }
  };
  $('showAllActivity').onclick = () => { $('activitySince').value = ''; changeActivityView(null); };
  function applyDateFilter() {
    const through = parseActivityDate($('activitySince').value, $('activitySince').validity.valid);
    if (!through) { activityDateInvalid = true; renderDateFilter(); return; }
    changeActivityView(through);
  }
  $('activitySince').oninput = applyDateFilter;
  $('activitySince').onchange = applyDateFilter;
  $('activitySince').onblur = () => { activityDateInvalid = false; syncDateFilter(); renderDateFilter(); };
  for (const [id, path, text] of [['startOrch', '/api/start', 'Orchestrator starting'], ['stopOrch', '/api/stop', 'Orchestrator stop requested'], ['startTunnel', '/api/tunnel/start', 'Tunnel starting'], ['stopTunnel', '/api/tunnel/stop', 'Tunnel stopped']]) {
    $(id).onclick = () => {
      if (id === 'stopTunnel' && !confirm('Stop the public tunnel? Remote dashboard access and phone WebSocket delivery will disconnect.')) return;
      if (id === 'startOrch' && $('phoneHealth').textContent === 'Needs attention' && !confirm('Phone delivery needs attention. Start monitoring anyway? Alerts may not reach your phone.')) return;
      perform($(id), () => api(path, 'POST'), text);
    };
  }
  $('pollInterval').oninput = () => { pollDirty = true; setText('pollSaveState', 'Unsaved'); };
  $('keepAwake').onchange = async () => {
    keepAwakeSaving = true; $('keepAwake').disabled = true;
    setText('keepAwakeSaveState', 'Saving…');
    try {
      const value = await api('/api/config/keep-awake', 'PUT', { enabled: $('keepAwake').checked });
      runtime.desktop = { ...runtime.desktop, keepAwake: value.enabled };
      setText('keepAwakeSaveState', value.tray?.notified ? 'Saved' :
        value.tray?.reason === 'unavailable' ? 'Saved · applies when tray starts' : 'Saved · tray notification failed');
    } catch (e) {
      setText('keepAwakeSaveState', 'Save failed'); notify(e.message, true);
    } finally { keepAwakeSaving = false; renderStatus(); }
  };
  $('presenceSelect').onchange = async () => {
    const version = ++presenceRevision;
    const requested = $('presenceSelect').value;
    presenceChanging = true;
    setText('presenceLabel', 'Setting status…');
    try {
      const v = await api('/api/teams/presence', 'PUT', { status: requested });
      if (version !== presenceRevision) return;
      if (!v.verified || v.superseded) throw new Error('Status selection was superseded; checking Teams status');
      $('presenceSelect').value = v.value;
      setText('presenceLabel', 'Set status');
      failures.delete('Teams status');
    } catch (e) {
      if (version !== presenceRevision) return;
      setText('presenceLabel', 'Set status · failed'); notify(e.message, true);
    } finally {
      if (version === presenceRevision) { presenceChanging = false; slowAt = 0; }
    }
  };
  $('pollForm').onsubmit = (e) => { e.preventDefault(); perform($('savePoll'), async () => { await api('/api/config/poll-interval', 'PUT', { pollIntervalMs: Number($('pollInterval').value) * 1000 }); pollDirty = false; setText('pollSaveState', 'Saved'); }, 'Polling interval saved'); };
  for (const id of ['deliveryMethod', 'fallbackEnabled']) $(id).onchange = () => { deliveryDirty = true; setText('deliverySaveState', 'Unsaved'); };
  $('deliveryForm').onsubmit = (e) => { e.preventDefault(); if (!deliveryReady) return; perform($('saveDelivery'), async () => { const transport = $('deliveryMethod').value; await api('/api/config/alerts', 'PUT', { transport, fallbackTransport: $('fallbackEnabled').checked ? (transport === 'fcm' ? 'websocket' : 'fcm') : null }); deliveryDirty = false; setText('deliverySaveState', 'Saved'); }, 'Phone delivery saved'); };
  for (const id of ['replyMode', 'replyEntries']) $(id).addEventListener('input', () => { policyDirty = true; setText('policySaveState', 'Unsaved'); policySummary(); });
  $('policyForm').onsubmit = (e) => { e.preventDefault(); if (!policyReady) return; perform($('savePolicy'), async () => { await api('/api/reply-policy', 'PUT', { mode: $('replyMode').value, entries: $('replyEntries').value.split('\n').map((v) => v.trim()).filter(Boolean) }); policyDirty = false; setText('policySaveState', 'Saved'); }, 'Teams reply permissions saved'); };
  $('brainContext').oninput = () => { profileDirty = true; setText('profileSaveState', 'Unsaved'); };
  $('profileForm').onsubmit = (e) => { e.preventDefault(); if (!profileReady) return; perform($('saveProfile'), async () => { await api('/api/profile', 'PUT', { text: $('brainContext').value }); profileDirty = false; setText('profileSaveState', 'Saved'); }, 'Brain context saved for the next poll'); };
  $('rulesForm').oninput = () => { rulesDirty = true; setText('rulesSaveState', 'Unsaved'); };
  $('rulesForm').onsubmit = (e) => { e.preventDefault(); if (!agentPolicyReady) return; perform($('ruleFields'), async () => { const saved = await api('/api/agent/policy', 'PUT', { source: $('alertRules').value }); $('alertRules').value = saved.source; rulesDirty = false; setText('rulesSaveState', 'Saved'); }, 'JavaScript policy saved'); };
  $('agentPermissionsForm').oninput = () => { agentPermissionsDirty = true; agentPermissionsRevision++; setText('agentPermissionsState', 'Unsaved'); };
  $('agentPermissionsForm').onsubmit = async e => {
    e.preventDefault(); if (agentPermissionsSaving || $('agentPermissionsFields').disabled) return;
    agentPermissionsSaving = true; agentPermissionsRevision++; $('agentPermissionsFields').disabled = true; setText('agentPermissionsState', 'Saving…');
    try {
      const saved = await api('/api/agent/permissions', 'PUT', { source: $('agentPermissions').value });
      $('agentPermissions').value = saved.source; agentPermissionsDirty = false;
      setText('agentPermissionsState', 'Saved');
    } catch (error) { setText('agentPermissionsState', 'Save failed'); notify(error.message, true); }
    finally { agentPermissionsSaving = false; $('agentPermissionsFields').disabled = false; }
  };
  $('sandboxForm').oninput = () => { sandboxDirty = true; sandboxRevision++; setText('sandboxSaveState', 'Unsaved'); };
  $('sandboxForm').onsubmit = async e => {
    e.preventDefault(); if (sandboxSaving || $('sandboxFields').disabled) return;
    sandboxSaving = true; sandboxRevision++; $('sandboxFields').disabled = true;
    setText('sandboxSaveState', 'Saving…');
    try {
      const saved = await api('/api/agent/sandbox', 'PUT', { source: $('sandboxLimits').value });
      $('sandboxLimits').value = saved.source; sandboxDirty = false; setText('sandboxSaveState', 'Saved');
    } catch (error) { setText('sandboxSaveState', 'Save failed'); notify(error.message, true); }
    finally { sandboxSaving = false; $('sandboxFields').disabled = false; }
  };

  let agentNotes = [];
  function showJson(id, value) { $(id).textContent = JSON.stringify(value, null, 2); }
  function addAgentEntry(parent, title, value, meta = '') {
    const article = document.createElement('article'); article.className = 'agent-entry';
    const heading = document.createElement('div'); heading.className = 'inline-heading';
    const strong = document.createElement('strong'); strong.textContent = title; heading.append(strong);
    if (meta) { const small = document.createElement('span'); small.textContent = meta; heading.append(small); }
    article.append(heading);
    if (value?.output) { const output = document.createElement('p'); output.className = 'hint'; output.textContent = String(value.output).slice(0, 1600); article.append(output); }
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Details';
    const pre = document.createElement('pre'); pre.textContent = pretty(value); details.append(summary, pre); article.append(details);
    parent.append(article); return article;
  }
  function renderAgent(value) {
    agentStatus = value;
    const current = value.current;
    setText('agentCurrent', current ? `${current.trigger || 'Working'} · ${current.conversationId || 'Fresh history'} · started ${time(current.startedAt)}` : 'Idle');
    $('agentRunCancel').disabled = !current || agentBusy;
    const selected = $('agentConversationSelect'), selectedId = selected.value;
    const choices = value.modelConversations || [];
    const signature = JSON.stringify(choices.map(c => [c.id, c.turns, c.canIntervene, c.invalid]));
    if (selected.dataset.signature !== signature) {
      selected.replaceChildren(new Option(choices.length ? 'Select a conversation' : 'No named conversations yet', ''));
      for (const c of choices) selected.add(new Option(`${c.id} · ${c.turns || 0} turns${c.invalid ? ' · Invalid history' : ''}`, c.id));
      selected.value = choices.some(c => c.id === selectedId) ? selectedId : '';
      selected.dataset.signature = signature;
    }
    const chosen = choices.find(c => c.id === selected.value);
    $('agentInterveneSubmit').disabled = !chosen?.canIntervene || agentBusy;
    $('agentConversationReset').disabled = !chosen || chosen.active || agentBusy;
    $('agentConversationInspect').disabled = !chosen || chosen.active || agentBusy;
    const mode = value.mode || 'active'; if (!agentModeDirty) $('agentMode').value = mode;
    status('agentModeBadge', mode.replaceAll('_', ' '), mode === 'active' ? 'good' : mode === 'paused' ? 'warn' : 'neutral');
    syncAgentRecordList($('agentRecords'), (value.records || []).slice(0, 25), record =>
      addAgentEntry(document.createDocumentFragment(), `${record.kind || 'record'} · ${time(record.at)}`, record.value));
    const actions = $('agentActions'); actions.replaceChildren();
    for (const action of value.actions || []) {
      const entry = addAgentEntry(actions, `${action.id} · ${action.state || 'unknown'}`, action.value, action.due ? `Due ${time(action.due)}` : '');
      if (action.result !== undefined && action.result !== null) {
        const result = document.createElement('p'); result.className = 'hint'; result.textContent = 'Result: ' + pretty(action.result); entry.append(result);
      }
      if (action.state === 'pending') {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'small danger'; cancel.textContent = 'Cancel'; cancel.dataset.agentCancel = action.id; entry.append(cancel);
      }
    }
    if (!actions.childElementCount) actions.textContent = 'No pending or recent agent actions.';
    const conversations = $('agentConversations'); conversations.replaceChildren();
    for (const conversation of value.conversations || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'agent-conversation';
      button.textContent = `${conversation.chat} · ${conversation.count} messages · ${time(conversation.last)}`;
      button.dataset.agentChat = conversation.chat; conversations.append(button);
    }
    if (!conversations.childElementCount) conversations.textContent = 'No conversation history available yet.';
  }
  async function refreshAgent() {
    if (agentRefreshing || $('login').open) return;
    agentRefreshing = true;
    try {
      const [value, policy] = await Promise.all([api('/api/agent/status'), api('/api/agent/policy')]);
      renderAgent(value);
      showPolicyFile(policy);
      if (!rulesDirty) $('alertRules').value = policy.source;
      agentPolicyReady = true; $('ruleFields').disabled = false;
      setText('agentRefreshState', 'Updated ' + time(new Date().toISOString()));
      const sandboxVersion = sandboxRevision;
      const sandbox = await api('/api/agent/sandbox');
      status('sandboxStatus', 'Unavailable', 'warn');
      $('sandboxStatus').hidden = sandbox.available;
      setText('sandboxInfo', sandbox.reason);
      if (!sandboxDirty && !sandboxSaving && sandboxVersion === sandboxRevision) {
        if ($('sandboxLimits').value !== sandbox.source) $('sandboxLimits').value = sandbox.source;
        $('sandboxFields').disabled = false;
      }
      if (!agentPermissionsDirty && !agentPermissionsSaving) {
        const revision = agentPermissionsRevision;
        const ceiling = await api('/api/agent/permissions');
        // An edit/save may have begun while the request was in flight.
        if (!agentPermissionsDirty && !agentPermissionsSaving && revision === agentPermissionsRevision) {
          if ($('agentPermissions').value !== ceiling.source) $('agentPermissions').value = ceiling.source;
          $('agentPermissionsFields').disabled = false;
        }
      }
    } catch (e) { setText('agentRefreshState', e.message); }
    finally { agentRefreshing = false; }
  }
  async function runAgentAction(button, work, success) {
    if (agentBusy) return;
    agentBusy = true; button.disabled = true;
    try { const result = await work(); if (success) notify(success); return result; }
    catch (e) { notify(e.message, true); return null; }
    finally { agentBusy = false; button.disabled = false; await refreshAgent(); }
  }
  $('agentRefresh').onclick = refreshAgent;
  $('agentMode').onchange = () => { agentModeDirty = true; };
  $('agentModeForm').onsubmit = e => {
    e.preventDefault(); const button = $('agentModeSave');
    runAgentAction(button, async () => { const saved = await api('/api/agent/mode', 'PUT', { mode: $('agentMode').value }); agentModeDirty = false; $('agentMode').value = saved.mode; return saved; }, 'Agent mode saved');
  };
  $('agentInterveneForm').onsubmit = async e => {
    e.preventDefault(); const prompt = $('agentIntervention').value.trim(), conversationId = $('agentConversationSelect').value;
    if (!prompt || !conversationId) return;
    const queued = await runAgentAction($('agentInterveneSubmit'), () => api('/api/agent/intervene', 'POST', { prompt, conversationId }), 'Intervention queued for the next turn');
    if (queued) $('agentIntervention').value = '';
  };
  $('agentConversationSelect').onchange = () => { setText('agentConversationHistory', 'Choose View history to inspect this conversation.'); if (agentStatus) renderAgent(agentStatus); };
  $('agentConversationInspect').onclick = () => {
    const id = $('agentConversationSelect').value; if (!id) return;
    runAgentAction($('agentConversationInspect'), async () => {
      const history = await api('/api/agent/conversation?id=' + encodeURIComponent(id));
      if ($('agentConversationSelect').value === id) showJson('agentConversationHistory', history);
      return history;
    });
  };
  $('agentConversationReset').onclick = () => {
    const conversationId = $('agentConversationSelect').value;
    if (!conversationId || !confirm('Reset this conversation? Old history stays in local records. Its active run and queued continuations will be invalidated; executed actions are unchanged.')) return;
    runAgentAction($('agentConversationReset'), async () => {
      const result = await api('/api/agent/conversation/reset', 'POST', { conversationId });
      if ($('agentConversationSelect').value === conversationId) setText('agentConversationHistory', 'History reset. View history includes the archived version.');
      return result;
    }, 'Conversation reset');
  };
  $('agentRunCancel').onclick = () => {
    const runId = agentStatus?.current?.runId; if (!runId) return;
    runAgentAction($('agentRunCancel'), () => api('/api/agent/run/cancel', 'POST', { runId }), 'Cancellation requested; executed actions are unchanged');
  };
  $('agentReplayForm').onsubmit = e => {
    e.preventDefault(); const messageId = $('agentReplayId').value.trim(); if (!messageId) return;
    runAgentAction($('agentReplaySubmit'), async () => {
      const result = await api('/api/agent/replay', 'POST', { messageId }); showJson('agentReplayResult', result);
      if (result.ok) notify('Replay completed with model and external actions disabled'); else notify(result.error?.message || 'Replay failed', true);
      return result;
    });
  };
  $('agentWakeForm').onsubmit = e => {
    e.preventDefault(); const prompt = $('agentWakePrompt').value.trim(), raw = $('agentWakeWhen').value, due = new Date(raw);
    if (!prompt || !Number.isFinite(due.getTime()) || due.getTime() <= Date.now()) { notify('Enter a prompt and a valid future time.', true); return; }
    runAgentAction($('agentWakeSubmit'), () => api('/api/agent/wake', 'POST', { prompt, conversationId: $('agentWakeConversation').value.trim() || null, dueAt: due.toISOString() }), 'Agent wake scheduled');
  };
  $('agentWakeWhen').value = localDateTime(Date.now() + 10 * 60000).slice(0, 16);
  $('agentWakeTimezone').textContent = 'Time zone: ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('agentActions').onclick = e => {
    const button = e.target.closest('[data-agent-cancel]'); if (!button) return;
    runAgentAction(button, () => api('/api/agent/actions/' + encodeURIComponent(button.dataset.agentCancel) + '/cancel', 'POST'), 'Agent action cancelled');
  };
  $('agentConversations').onclick = e => {
    const button = e.target.closest('[data-agent-chat]'); if (!button) return;
    $('agentBriefChat').value = button.dataset.agentChat; $('agentBriefLoad').click();
  };
  $('agentNotesRefresh').onclick = async () => {
    try {
      const data = await api('/api/agent/notes'); agentNotes = data.notes || [];
      const select = $('agentNoteSelect'), selectedPath = agentNotePath || select.value;
      select.replaceChildren();
      for (const note of agentNotes) { const option = document.createElement('option'); option.value = note.path; option.textContent = note.path; select.append(option); }
      if (agentNotes.some(note => note.path === selectedPath)) select.value = selectedPath;
      else if (!agentNoteDirty) { agentNotePath = select.value; $('agentNotePath').value = agentNotePath; }
      if (!agentNoteDirty && select.value) await loadAgentNote(select.value);
    } catch (e) { setText('agentNoteState', e.message); }
  };
  async function loadAgentNote(path, force = false) {
    if (!path || (agentNoteDirty && !force)) return;
    try {
      const note = await api('/api/agent/note?path=' + encodeURIComponent(path));
      agentNotePath = note.path; $('agentNotePath').value = note.path; $('agentNoteSelect').value = note.path; $('agentNoteText').value = note.text;
      agentNoteDirty = false; setText('agentNoteState', 'Loaded');
    } catch (e) { setText('agentNoteState', e.message); }
  }
  $('agentNoteSelect').onchange = () => {
    const next = $('agentNoteSelect').value;
    if (agentNoteDirty && !confirm('Discard unsaved note edits?')) { $('agentNoteSelect').value = agentNotePath; return; }
    agentNoteDirty = false; loadAgentNote(next, true);
  };
  $('agentNoteText').oninput = () => { agentNoteDirty = true; setText('agentNoteState', 'Unsaved'); };
  $('agentNotePath').oninput = () => { agentNoteDirty = true; setText('agentNoteState', 'Unsaved path'); };
  $('agentNoteNew').onclick = () => {
    const path = prompt('New note path, for example people/alex.md'); if (!path) return;
    if (agentNoteDirty && !confirm('Discard unsaved note edits?')) return;
    agentNotePath = path; $('agentNotePath').value = path; $('agentNoteSelect').value = ''; $('agentNoteText').value = ''; agentNoteDirty = true; setText('agentNoteState', 'New note · unsaved');
  };
  $('agentNoteSave').onclick = () => {
    const path = $('agentNotePath').value.trim(); if (!path) { notify('Choose or enter a note path.', true); return; }
    runAgentAction($('agentNoteSave'), async () => {
      const saved = await api('/api/agent/note', 'PUT', { path, text: $('agentNoteText').value });
      agentNotePath = saved.path; $('agentNotePath').value = saved.path; agentNoteDirty = false;
      setText('agentNoteState', 'Saved'); await $('agentNotesRefresh').onclick();
    }, 'Note saved');
  };
  $('agentBriefLoad').onclick = async () => {
    const chat = $('agentBriefChat').value.trim(); if (!chat) { setText('agentBriefState', 'Enter an exact chat name.'); return; }
    try { const brief = await api('/api/agent/brief?chat=' + encodeURIComponent(chat)); $('agentBriefChat').value = brief.chat; $('agentBriefText').value = brief.text; agentBriefDirty = false; setText('agentBriefState', 'Loaded'); }
    catch (e) { setText('agentBriefState', e.message); }
  };
  $('agentBriefText').oninput = () => { agentBriefDirty = true; setText('agentBriefState', 'Unsaved'); };
  $('agentBriefSave').onclick = () => {
    const chat = $('agentBriefChat').value.trim(); if (!chat) { notify('Enter the exact chat name.', true); return; }
    runAgentAction($('agentBriefSave'), async () => {
      const saved = await api('/api/agent/brief', 'PUT', { chat, text: $('agentBriefText').value });
      $('agentBriefChat').value = saved.chat; agentBriefDirty = false; setText('agentBriefState', 'Saved');
    }, 'Brief saved');
  };
  $('agentNotesRefresh').click();
  $('searchMessages').oninput = () => renderMessages(true);
  $('messageFilter').onchange = () => renderMessages(true);
  function selectMessage(e) {
    const row = e.target.closest('[data-flow]'); if (!row || !window.getSelection()?.isCollapsed) return;
    selected = row.dataset.flow; renderMessages(true); renderFlow(true);
  }
  $('messages').onclick = selectMessage;
  $('messages').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMessage(e); } };
  for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => {
    for (const tab of document.querySelectorAll('[data-view]')) { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); }
    $('activityView').hidden = button.dataset.view !== 'activity'; $('logsView').hidden = button.dataset.view !== 'logs';
  };
  $('logSource').onchange = () => { for (const node of document.querySelectorAll('.log-output')) node.hidden = node.id !== $('logSource').value; };
  $('copyLog').onclick = async () => { try { await navigator.clipboard.writeText($($('logSource').value).textContent); notify('Log copied'); } catch { notify('Could not copy. Select the log text to copy it manually.', true); } };
    window.addEventListener('beforeunload', (e) => { if (deliveryDirty || policyDirty || profileDirty || pollDirty || rulesDirty || agentModeDirty || agentNoteDirty || agentBriefDirty || agentPermissionsDirty || agentPermissionsSaving || activityDirty || activitySaving) { e.preventDefault(); e.returnValue = ''; } });
  policySummary(); refresh(true);
  refreshSupervisor();
  // Supervisor safety status stays live even while message/log tailing is paused.
  setInterval(refreshSupervisor, 5000);
  refreshSchedules(); setInterval(refreshSchedules, 5000);
  refreshAgent(); setInterval(refreshAgent, 5000);
  setInterval(() => {
    if (supervisorCheckedAt && Date.now() - supervisorCheckedAt > 15000) {
      status('supervisorHealth', 'Status stale', 'warn');
    }
  }, 1000);
  setInterval(() => refresh(), 2000);
  setInterval(() => { if (!paused) renderPoll(); }, 1000);
}

export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TM — Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#101619;--paper:#182126;--ink:#e3e9ed;--muted:#9eacb6;--line:#2c383f;--green:#62c49c;--soft:#20392f;--orange:#e5b16c;--red:#f28e96;--navy:#111e23;--radius:12px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;transition:background .15s,border-color .15s}button:disabled{opacity:.45;cursor:default}button,input,textarea,select{border:1px solid #3a4952;border-radius:7px}button{background:#151e23;color:var(--ink);padding:7px 12px;font-weight:600}button:hover:not(:disabled){background:#293a3d;border-color:#668579}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #75c9a7;outline-offset:2px}input,textarea,select{background:#151e23;color:var(--ink);padding:9px 11px;width:100%}textarea{resize:vertical;line-height:1.6}h1,h2,h3,p{margin:0}h2{font-size:15px;font-weight:650}h3{font-size:16px}p{overflow-wrap:anywhere}header{background:var(--navy);color:#f5f9f7;min-height:68px;padding:0 32px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-weight:650;font-size:18px;letter-spacing:-.3px}.brandmark{display:grid;grid-template-columns:repeat(2,7px);gap:3px;transform:rotate(-6deg);padding:10px;background:#294940;border:1px solid #446154;border-radius:9px}.brandmark i{width:7px;height:7px;background:#a9d4b7;border-radius:2px}.header-right{display:flex;align-items:center;gap:14px}.header-right button{background:transparent;color:#d5e2de;border-color:#47605c;font-size:12px}.workspace-label{color:#9fb9b0;font-size:11px;letter-spacing:1.5px;font-weight:600}.shell{max-width:1720px;margin:auto;padding:27px 32px 48px}.page-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px;gap:16px}.eyebrow{font-size:10px;letter-spacing:1.5px;font-weight:700;color:var(--muted);margin-bottom:5px}h1{font-size:29px;line-height:1.25;letter-spacing:-.8px;font-weight:650}.subtitle{margin-top:7px;color:var(--muted);font-size:13px}.sync-meta{text-align:right;color:var(--muted);font-size:11px}.sync-meta button{margin-top:8px;font-size:11px;background:transparent}.badge{display:inline-flex;align-items:center;border-radius:5px;padding:3px 7px;font-size:10px;font-weight:650;line-height:1.4;white-space:nowrap}.badge.good{background:#203c31;color:#94d4af}.badge.warn{background:#493a24;color:#edc185}.badge.bad{background:#462b31;color:#f3a4ac}.badge.neutral{background:#29343c;color:#b5c0c8}.badge.info{background:#28374c;color:#a8c6f2}.header-right .badge.good{background:#294e40;color:#c5e8d0}.header-right .badge.good:before{content:"";height:6px;width:6px;border-radius:50%;background:#89d8aa;margin-right:7px}.notice{display:flex;gap:12px;padding:12px 16px;background:#30291f;border:1px solid #544431;border-radius:9px;margin-bottom:20px;font-size:12px;color:#e3bf8d}.notice-icon{font-weight:800;border:1px solid #92774f;border-radius:50%;width:19px;height:19px;text-align:center;flex-shrink:0}.notice strong{margin-right:6px}.connection-error{background:#422a30;color:#f0a0aa;padding:12px;border-radius:8px;margin-bottom:15px}.workspace{display:grid;grid-template-columns:330px minmax(0,1fr);gap:22px;align-items:start}.sidebar{display:grid;gap:16px}.card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}.card-body{padding:19px}.section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px}.section-number{color:#8797a1;font-size:10px;letter-spacing:1px}.runtime-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px}.runtime-name{font-weight:600;font-size:13px}.runtime-detail{font-size:11px;color:var(--muted);margin:3px 0 10px}.button-row{display:flex;gap:6px;align-items:center}.primary{background:#286a51;color:#f1fff8;border-color:#3e8b6d}.primary:hover:not(:disabled){background:#33765d;color:white}.small{font-size:11px;padding:6px 12px}.danger:hover:not(:disabled){color:var(--red);border-color:#9b626c;background:#39282e}.divider{border:0;border-top:1px solid var(--line);margin:17px 0}.hint{font-size:11px;color:var(--muted);margin:9px 0;line-height:1.55}.warning-text{color:var(--orange)}.mode-note{background:#1d2d2a;color:#a3c6b6;font-size:11px;padding:9px 12px;margin:16px -19px -19px;border-top:1px solid var(--line)}label{display:block;font-weight:600;font-size:11px;color:#adbac4;margin:11px 0 6px}.check{display:flex;align-items:center;gap:8px;font-weight:400;font-size:12px}.check input{width:15px;height:15px;accent-color:var(--green)}.form-footer{display:flex;justify-content:space-between;align-items:center;margin-top:11px;gap:8px}.save-state{font-size:10px;color:var(--green)}.poll-setting{display:flex;gap:7px;align-items:center}.poll-setting input{width:78px;padding:5px 9px}.poll-setting span{font-size:11px;color:var(--muted)}summary{cursor:pointer;font-size:11px;color:#9fc8b9;user-select:none;padding:7px 0}details{margin-top:11px}details[open]>summary{margin-bottom:7px}.health-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:8px 0;border-bottom:1px solid #2a343b}.health-row:last-of-type{border:0}.health-name{display:flex;gap:8px;align-items:center}.health-symbol{color:#9aada4;font-size:14px}.facts{display:grid;grid-template-columns:1fr 1.2fr;gap:7px;font-size:11px;margin:0}.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}.error-text{color:var(--red);font-size:11px}.main-column{min-width:0;display:grid;gap:18px}.poll-card{padding:20px 23px}.poll-heading{display:flex;justify-content:space-between;align-items:center;gap:10px}.poll-title{display:flex;align-items:center;gap:9px}.pulse-ring{width:27px;height:27px;border:1px solid #375849;border-radius:50%;display:grid;place-items:center;color:var(--green);font-size:18px}.poll-title h2{font-size:14px}.poll-meta{font-size:11px;color:var(--muted);margin-top:5px}.poll-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;border-top:1px solid var(--line);margin-top:18px;padding-top:15px}.stat{padding-left:15px;border-left:1px solid var(--line)}.stat:first-child{padding:0;border:0}.stat b{font-size:23px;line-height:1;font-weight:600;display:block;margin-bottom:6px;letter-spacing:-.5px}.stat span{font-size:11px;color:var(--muted)}.poll-foot{display:flex;justify-content:space-between;gap:10px;margin-top:13px;color:var(--muted);font-size:10px}.workspace-tabs{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:0 20px}.tabs{display:flex;gap:20px}.tab{border:0;border-radius:0;background:transparent;padding:16px 0 13px;color:var(--muted);font-size:12px;border-bottom:2px solid transparent}.tab.active{color:var(--green);border-bottom-color:var(--green)}.live-caption{font-size:10px;color:var(--muted)}.filterbar{display:flex;gap:10px;padding:15px 20px;border-bottom:1px solid var(--line);align-items:center}.filterbar input{font-size:12px;min-width:0;padding:8px 12px;background:#131c21}.filterbar select{font-size:11px;width:130px;padding:8px}.feed-grid{display:grid;grid-template-columns:minmax(260px,.95fr) minmax(290px,1.05fr);min-height:580px}.feed-column{border-right:1px solid var(--line);min-width:0}.feed-caption{padding:10px 20px;font-size:10px;letter-spacing:.6px;color:var(--muted);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;background:#172026}.message-list{max-height:760px;overflow:auto;scrollbar-width:thin}.message{display:block;text-align:left;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:16px 20px;font-weight:400;background:#151e23}.message:hover:not(:disabled){background:#22332e}.message.selected{background:#1e332c;box-shadow:inset 3px 0 var(--green)}.message-top{display:flex;gap:9px;align-items:center}.message-top strong{font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1}.avatar{width:27px;height:27px;display:grid;place-items:center;flex-shrink:0;font-size:12px;font-weight:650;border-radius:8px;background:#303b48;color:#b0c1d6}.selected .avatar{background:#2b4c3a;color:#b1ddc0}.message-arrow{color:#a1aca7;font-size:15px}.message-copy{font-size:12px;line-height:1.65;margin:10px 0;color:#b0bdc5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.message-meta{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;color:var(--muted)}time{display:block;font-size:10px;color:#98a7b2;margin-top:7px}.pipeline{padding:22px;max-height:803px;overflow:auto;min-width:0;scrollbar-width:thin}.flow-intro{padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:22px}.flow-intro h3{font-size:16px;margin-top:5px;overflow-wrap:anywhere}.flow-intro p{font-size:11px;color:var(--muted);margin:6px 0 10px}.timeline{list-style:none;margin:0;padding:0 0 0 31px}.stage{position:relative;padding:0 0 24px 0;border-left:0}.stage:not(:last-child):before{content:"";position:absolute;left:-21px;top:21px;bottom:0;border-left:1px solid #3b5549}.stage-dot{position:absolute;left:-31px;top:0;width:21px;height:21px;border-radius:50%;background:#294333;color:#a7d7b5;font-size:10px;font-weight:700;text-align:center;line-height:21px}.stage.failed .stage-dot{background:#512e39;color:var(--red)}.stage-title{display:flex;justify-content:space-between;align-items:center;gap:6px;line-height:21px}.stage-title strong{font-size:12px}.stage-title span{font-size:9px;color:var(--muted);white-space:nowrap}.stage p{font-size:12px;line-height:1.6;margin-top:7px;color:#bac6ce;white-space:pre-wrap}.stage time{margin-top:0}.stage .badge{margin-top:6px}.stage details{margin-top:4px}.stage summary{font-size:10px}.stage pre{max-height:340px;overflow:auto;font-size:10px;white-space:pre-wrap;background:#111b20;border:1px solid var(--line);padding:10px;border-radius:6px;overflow-wrap:anywhere}.trace-note{font-size:11px;background:#202b33;padding:12px;color:var(--muted);border-radius:6px}.empty{text-align:center;padding:65px 22px;color:var(--muted)}.empty h3{font-size:14px;color:#afc8b9;margin:12px 0 7px}.empty p{font-size:12px;line-height:1.7}.empty-icon{font-size:30px;color:#8db4a1}.logs-toolbar{display:flex;gap:10px;align-items:center;padding:16px 20px}.logs-toolbar select{width:220px;font-size:12px}.log-output{background:#101b20;color:#d1ded9;padding:22px;margin:0;min-height:520px;max-height:820px;overflow:auto;font:11px/1.8 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.log-note{padding:12px 20px;font-size:11px;color:var(--muted)}.footer-note{display:flex;justify-content:space-between;font-size:10px;color:#94a3ad;padding:0 3px}.toast{position:fixed;right:24px;bottom:24px;background:#285942;color:white;padding:13px 20px;box-shadow:0 6px 30px #102d2925;border-radius:9px;z-index:15;max-width:420px}.toast.error{background:#783c48}.hidden,[hidden]{display:none!important}dialog{border:1px solid var(--line);border-radius:16px;padding:30px;width:min(420px,90vw);box-shadow:0 20px 80px #10272b40}dialog::backdrop{background:#10272b70;backdrop-filter:blur(4px)}dialog h2{font-size:23px}dialog p{font-size:13px;color:var(--muted);margin:10px 0 20px}dialog button{margin-top:16px;width:100%}.inline-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.code-input{font:11px/1.6 Consolas,monospace}.brain-text{min-height:170px;font-size:12px}
@media(min-width:1500px){.workspace{grid-template-columns:350px minmax(0,1fr)}.feed-grid{grid-template-columns:minmax(310px,.9fr) minmax(350px,1.1fr)}}
@media(max-width:1100px){.shell{padding:22px 20px}.workspace{grid-template-columns:300px minmax(0,1fr);gap:16px}.feed-grid{grid-template-columns:1fr}.feed-column{border-right:0;border-bottom:1px solid var(--line)}.message-list{max-height:390px}.pipeline{max-height:600px}.page-heading h1{font-size:25px}.live-caption{display:none}}
@media(max-width:760px){header{padding:14px 18px;min-height:64px}.workspace-label{display:none}.header-right{gap:7px}.brand{font-size:16px}.shell{padding:20px 14px}.workspace{display:flex;flex-direction:column}.sidebar,.main-column{width:100%}.main-column{order:-1}.sidebar{grid-template-columns:1fr 1fr}.page-heading{align-items:flex-start}.sync-meta{max-width:135px;font-size:9px}.poll-card{padding:17px}.poll-heading{align-items:flex-start}.poll-title h2{font-size:12px}.filterbar{padding:12px}.card-body{padding:16px}.mode-note{margin:16px -16px -16px}.notice{font-size:11px}.pipeline{max-height:none}.footer-note{flex-direction:column;gap:5px}}
 @media(max-width:480px){.sidebar{grid-template-columns:1fr}.header-right button{font-size:10px;padding:5px}.header-right .badge{font-size:9px}.brandmark{padding:7px}.brand{gap:8px}.poll-stats{gap:5px}.stat{padding-left:9px}.stat span{font-size:10px}.stat b{font-size:21px}.poll-foot{flex-direction:column;gap:4px}.page-heading h1{font-size:23px}.subtitle{font-size:11px}.workspace-tabs{padding:0 14px}.tabs{gap:15px}.message-list{max-height:360px}}
.header-right .sync-time{font-size:10px;color:var(--muted);white-space:nowrap}.header-right #pauseUpdates{font-size:10px}
.activity-clear{padding:12px 20px 0}.activity-clear .button-row{flex-wrap:wrap}header,.header-right{flex-wrap:wrap}.header-right{justify-content:flex-end;padding:8px 0}@media(max-width:760px){.header-right{width:100%;justify-content:flex-start}.header-right .sync-time{width:100%}.activity-clear{padding:12px 12px 0}}
.header-right .live-toggle.good{background:#294e40;color:#c5e8d0;border-color:#568169}.header-right .live-toggle.warn{background:#493a24;color:#edc185;border-color:#806842}.live-toggle:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;background:currentColor}.live-toggle.neutral:before{background:#8e9ca4}.message{cursor:text;user-select:text;-webkit-user-select:text}.message:focus-visible{outline:2px solid var(--green);outline-offset:-2px}.message-top strong{font-size:15px;white-space:normal}.message-author{font-size:13px;font-weight:600;color:#b9c6cf;margin-top:4px}.message-copy{display:block;overflow:visible;white-space:pre-wrap}.action-icons{display:flex;gap:7px;flex-shrink:0}.action-icon{font-size:18px}.message.message-error{background:#352128}.message.message-error:hover{background:#422932}.message.message-error.selected{background:#482b34;box-shadow:inset 3px 0 var(--red)}.message-meta time{margin:0}.date-filter{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.date-filter label{margin:0}.date-filter input[type=datetime-local]{width:auto;max-width:100%;font-size:11px}.date-filter button{margin-left:auto}
.settings-fields{border:0;padding:0;margin:0;min-width:0}.settings-fields .check{margin:12px 0}.settings-fields:disabled{opacity:.6}
.schedule-layout{display:grid;grid-template-columns:minmax(220px,.85fr) minmax(280px,1.15fr);gap:24px}.schedule-job{padding:12px;border:1px solid var(--line);border-radius:8px;margin-bottom:9px;background:#151e23}.schedule-job strong{font-size:12px;overflow-wrap:anywhere}.schedule-job time{font-size:12px}.scheduled-text{white-space:pre-wrap;font-size:12px;margin-top:8px}.schedule-queue{max-height:430px;overflow:auto}.schedule-layout details{margin:0}.schedule-layout summary{font-size:12px}@media(max-width:900px){.schedule-layout{grid-template-columns:1fr}}
.agent-current{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;background:#131d21;border:1px solid var(--line);border-radius:8px;font-size:12px}.agent-current span:nth-child(2){color:#c2d0d7}.agent-controls{display:flex;align-items:center;gap:8px}.agent-controls>*{min-width:0}.agent-controls input,.agent-controls select{flex:1}.agent-mode-form{margin-top:12px}.agent-form{margin-top:13px}.agent-tools,.agent-columns,.agent-memory{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:17px;padding-top:15px;border-top:1px solid var(--line)}.agent-memory{grid-template-columns:repeat(3,minmax(0,1fr))}.agent-columns h3,.agent-memory h3{font-size:12px}.agent-list{display:grid;gap:8px;margin-top:8px;max-height:340px;overflow:auto}.agent-entry{border:1px solid var(--line);border-radius:7px;background:#141e23;padding:9px;min-width:0}.agent-entry strong{font-size:11px;overflow-wrap:anywhere}.agent-entry .inline-heading>span{font-size:10px;color:var(--muted)}.agent-entry pre,.agent-output{background:#10191d;border:1px solid #2a363c;border-radius:5px;padding:8px;margin:7px 0 0;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.55 Consolas,monospace;color:#c4d2d9}.agent-entry .hint{white-space:pre-wrap}.agent-entry button{margin-top:8px}.agent-conversations{display:grid;gap:6px;max-height:300px;overflow:auto;margin-top:8px}.agent-conversation{width:100%;text-align:left;font-size:10px;padding:7px 9px;overflow-wrap:anywhere}.agent-tools form{min-width:0}.agent-memory>div{min-width:0}.agent-memory .agent-controls{align-items:stretch}.agent-memory .agent-controls button{flex:0 0 auto}.agent-memory textarea{min-height:100px}.agent-current .save-state{margin-left:auto}@media(max-width:900px){.agent-memory{grid-template-columns:1fr 1fr}}@media(max-width:600px){.agent-tools,.agent-columns,.agent-memory{grid-template-columns:1fr}.agent-controls{flex-wrap:wrap}.agent-current .save-state{margin-left:0}}
.policy-file{color:var(--green);overflow-wrap:anywhere;text-decoration:underline}.policy-file:focus-visible{outline:3px solid #75c9a7;outline-offset:2px}
</style></head><body>
<header><div class="brand"><span class="brandmark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>TM <span class="workspace-label">/ LOCAL CONTROL</span></div><div class="header-right"><span id="lastRefresh" class="sync-time">Waiting for server</span><button id="pauseUpdates" class="live-toggle warn" aria-pressed="true" title="Connecting · Pause live log tailing">Pause live log tailing</button><button id="refreshButton" title="Manually sync tail" aria-label="Manually sync tail">↻</button><button id="accountButton">Access token</button></div></header>
<main class="shell">
<div id="connectionError" class="connection-error" role="alert" hidden></div><div id="attention" class="notice" hidden><span class="notice-icon">!</span><div><strong>Setup required</strong><span id="attentionText"></span></div></div>
<div class="workspace"><aside class="sidebar" aria-label="Controls and settings">
<section class="card"><div class="card-body"><div class="section-title"><h2>Runtime controls</h2></div>
<div class="runtime-row"><div class="runtime-name">Teams orchestrator</div><span id="orchStatus" class="badge neutral">Checking</span></div><p id="orchDetail" class="runtime-detail">Checking heartbeat…</p><div class="button-row"><button id="startOrch" class="primary small" disabled>▶ Start monitor</button><button id="stopOrch" class="small danger" disabled>Stop</button></div>
<form id="pollForm"><label for="pollInterval">Time between Teams polls</label><div class="poll-setting"><input id="pollInterval" type="number" min="1" max="300" step="1" required aria-label="Poll interval in seconds"><span>seconds</span><button id="savePoll" class="small">Save</button><span id="pollSaveState" class="save-state"></span></div></form>
<label class="check"><input id="keepAwake" type="checkbox" disabled>Keep screen on</label><span id="keepAwakeSaveState" class="save-state" aria-live="polite"></span>
<hr class="divider"><div class="runtime-name">Teams availability</div><label id="presenceLabel" for="presenceSelect" aria-live="polite">Set status</label><select id="presenceSelect"><option value="available">Available</option><option value="away">Appear away</option><option value="offline">Appear offline</option><option value="busy">Busy</option><option value="dnd">Do not disturb</option><option value="brb">Be right back</option><option value="" disabled>Unknown / unavailable</option></select>
<hr class="divider"><div class="runtime-row"><div class="runtime-name">Cloudflare tunnel</div><span id="tunnelStatus" class="badge neutral">Checking</span></div><p id="tunnelDetail" class="runtime-detail">Remote access to this laptop</p><div class="button-row"><button id="startTunnel" class="small" disabled>Start tunnel</button><button id="stopTunnel" class="small danger" disabled>Stop</button></div></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Phone delivery</h2></div><form id="deliveryForm"><label for="deliveryMethod">Preferred delivery method</label><select id="deliveryMethod"><option value="fcm">FCM</option><option value="websocket">Websocket</option></select><label class="check"><input id="fallbackEnabled" type="checkbox">Use the other method if delivery fails</label><div class="form-footer"><span id="deliverySaveState" class="save-state"></span><button id="saveDelivery" class="small">Save delivery</button></div></form><p id="deliveryHint" class="hint">Checking phone delivery…</p><p id="activeTransport" class="hint"></p><details><summary>Setup & recovery details</summary><div id="setupDetails"></div></details></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>System health</h2></div>
<div class="health-row"><span>GUI supervisor</span><span id="supervisorHealth" class="badge neutral" aria-live="polite">Checking</span></div>
<div class="health-row"><span class="health-name"><span class="health-symbol">◈</span>Teams connection</span><span id="teamsHealth" class="badge neutral">Checking</span></div><div class="health-row"><span class="health-name"><span class="health-symbol">◎</span>Phone delivery</span><span id="phoneHealth" class="badge neutral">Checking</span></div><div class="health-row"><span class="health-name"><span class="health-symbol">◇</span>Brain</span><span id="brainHealth" class="badge neutral">Checking</span></div><div class="health-row"><span>Phone WebSocket</span><span id="wsHealth" class="badge neutral">Checking</span></div><div class="health-row"><span>Public tunnel probe</span><span id="publicHealth" class="badge neutral">Checking</span></div><p id="brainModel" class="hint"></p><p class="hint">Teams can connect when the monitor starts. FCM send acceptance does not confirm phone receipt.</p></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Teams reply permissions</h2></div><p class="hint">Controls outgoing Teams replies, including holding messages. Phone alerts are unaffected.</p><form id="policyForm"><label for="replyMode">Permission mode</label><select id="replyMode"><option value="whitelist">Whitelist · only listed chats</option><option value="blacklist">Blacklist · all except listed chats</option></select><label for="replyEntries">Chat names, one per line</label><textarea id="replyEntries" rows="4" placeholder="e.g. Project chat&#10;Alex Morgan"></textarea><p class="hint">Exact chat names, case-insensitive. No wildcards.</p><p id="policyHint" class="hint"></p><div class="form-footer"><span id="policySaveState" class="save-state"></span><button id="savePolicy" class="small">Save permissions</button></div></form><p class="hint">Default: an empty whitelist allows replies to nobody.</p></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Brain context</h2></div><p class="hint">Instructions used by the brain for phone alerts and permitted Teams replies.</p><form id="profileForm"><label for="brainContext">Context & instructions</label><textarea id="brainContext" class="brain-text" rows="8" placeholder="Enter monitoring context and alert instructions…"></textarea><div class="form-footer"><span id="profileSaveState" class="save-state"></span><button id="saveProfile" class="small">Save context</button></div></form><p class="hint">Saved locally and picked up on the next poll.</p></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Agent permissions</h2></div>
<p class="hint">Global maximum for model tools. Each policy call can grant less, never more. Teams reply permissions still apply. This does not sandbox trusted JavaScript policy.</p>
<form id="agentPermissionsForm"><fieldset id="agentPermissionsFields" class="settings-fields" disabled><label for="agentPermissions">agent.ceiling · YAML</label><textarea id="agentPermissions" class="code-input" rows="18" spellcheck="false" aria-describedby="agentPermissionsHelp"></textarea><p id="agentPermissionsHelp" class="hint"><code>tools</code>: permitted tool names. <code>readChats</code>/<code>writeChats</code>: exact chat names or <code>'*'</code> for all. <code>initiateActions</code>: message, alert, status, wake. <code>cancelIds</code>: pending action IDs or <code>'*'</code>. <code>modifyIds</code>: IDs mapped to editable fields: <code>[text]</code> for messages, <code>[title, body]</code> for notifications, or <code>{}</code> for none. Empty lists permit none. Keep all six fields.</p><p class="hint">Tools: list_conversations, read_conversation, read_reactions, search_conversations, send_message, alert, set_status, schedule, cancel_action, modify_action, list_notes, read_note, search_notes, write_note.</p><div class="form-footer"><span id="agentPermissionsState" class="save-state" aria-live="polite"></span><button class="small">Save agent permissions</button></div></fieldset></form>
<p class="hint">Sandboxed <code>execute_bun</code> is always available for computation. Host tool access still requires the permissions above.</p>
<p class="hint">Restrictions are rechecked on tool calls and execution. Existing tasks cannot gain permission beyond their saved limits. Invalid saves leave the configuration unchanged.</p></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Bun sandbox</h2><span id="sandboxStatus" class="badge warn" hidden>Unavailable</span></div>
<p id="sandboxInfo" class="hint"></p><p class="hint">Native Windows isolation; no VM or WSL. Direct network access and filesystem writes are blocked. Host tools retain permission checks. Code faults and limit failures discard that execution’s changes.</p>
<form id="sandboxForm"><fieldset id="sandboxFields" class="settings-fields" disabled><label for="sandboxLimits">agent.sandbox · YAML</label><textarea id="sandboxLimits" class="code-input" rows="6" spellcheck="false"></textarea><p class="hint">Maximum per execution: timeoutMs (100–30000), memoryMb (256–2048), cpuPercent (1–25, total CPU capacity), maxProcesses (1–8), outputBytes (4096–262144). Policy calls and saved continuations can only lower these limits.</p><div class="form-footer"><span id="sandboxSaveState" class="save-state" aria-live="polite"></span><button class="small">Save sandbox limits</button></div></fieldset></form></div></section>
<section class="card" aria-labelledby="advancedTitle"><div class="card-body"><div class="section-title"><h2 id="advancedTitle">JavaScript policy</h2></div>
<p class="hint">Policy runs for each message with <code>handle(ctx, actions)</code>. Use the scoped action functions in <code>actions</code>; model work is explicit through <code>actions.llm(...)</code>. Saves validate before activation. Replay disables model calls and external actions.</p>
<form id="rulesForm"><fieldset id="ruleFields" class="settings-fields" disabled><label for="alertRules"><a id="policyFile" class="policy-file">policy.ts</a></label><textarea id="alertRules" class="code-input" rows="24" spellcheck="false" placeholder="export async function handle(ctx: PolicyContext, actions: PolicyActions) {&#10;  // Decide what to do with this message.&#10;}"></textarea><div class="form-footer"><span id="rulesSaveState" class="save-state" aria-live="polite"></span><button id="saveRules" class="small">Save TypeScript policy</button></div></fieldset></form></div></section>
</aside><section class="main-column" aria-label="Live monitoring">
<section class="card" aria-labelledby="agentHeading"><div class="card-body"><div class="section-title"><h2 id="agentHeading">Agent</h2><div class="button-row"><span id="agentModeBadge" class="badge neutral">Checking</span><button id="agentRefresh" class="small" type="button">Refresh agent</button></div></div>
<p class="hint">Paused stops model runs; deterministic policy still runs. Read-only prevents model-originated external actions and note edits; deterministic policy still runs. Neither mode changes manual messages/status scheduling.</p>
<div class="agent-current"><strong>Current work</strong><span id="agentCurrent">Checking…</span><span id="agentRefreshState" class="save-state"></span></div>
<form id="agentModeForm" class="agent-controls agent-mode-form"><label for="agentMode">Autonomy mode</label><select id="agentMode"><option value="active">Active</option><option value="read_only">Read only</option><option value="paused">Paused</option></select><button id="agentModeSave" class="small">Save mode</button></form>
<form id="agentInterveneForm" class="agent-form"><label for="agentConversationSelect">Model conversation</label><select id="agentConversationSelect"><option value="">No named conversations yet</option></select><label for="agentIntervention">Intervention</label><textarea id="agentIntervention" rows="2" placeholder="Instructions for the selected conversation’s next turn…"></textarea><div class="button-row"><button id="agentInterveneSubmit" class="primary small" disabled>Queue intervention</button><button id="agentRunCancel" class="small danger" type="button" disabled>Cancel current run</button><button id="agentConversationInspect" class="small" type="button" disabled>View history</button><button id="agentConversationReset" class="small danger" type="button" disabled>Reset history</button></div><p class="hint">Named conversations are created by explicit policy calls. Intervention continues one with its previously granted permissions, limited by the current ceiling. It queues after the current run; it does not cancel it or undo actions already executed. Responses appear in Recent tools and results.</p><details><summary>Selected conversation history</summary><pre id="agentConversationHistory" class="agent-output">Select a conversation and choose View history.</pre></details></form>
<div class="agent-tools"><form id="agentReplayForm"><label for="agentReplayId">Replay recorded message ID</label><div class="agent-controls"><input id="agentReplayId" placeholder="Recorded message ID"><button id="agentReplaySubmit" class="small">Replay safely</button></div><p class="hint">Replay disables model calls and external actions.</p><pre id="agentReplayResult" class="agent-output">No replay yet.</pre></form>
<form id="agentWakeForm"><label for="agentWakePrompt">Schedule an agent wake</label><textarea id="agentWakePrompt" rows="2" placeholder="What should the agent check at that time?"></textarea><label for="agentWakeConversation">Conversation ID · optional</label><input id="agentWakeConversation" placeholder="Blank starts with fresh history"><label for="agentWakeWhen">Run at</label><input id="agentWakeWhen" type="datetime-local"><p id="agentWakeTimezone" class="hint"></p><button id="agentWakeSubmit" class="small">Schedule wake</button><p class="hint">A named wake continues that history. Existing conversations retain their prior permission limits; fresh wakes use the current ceiling. All limits are rechecked at execution. Wakeups appear with other agent actions.</p></form></div>
<div class="agent-columns"><div><div class="inline-heading"><h3>Recent tools and results</h3><span class="hint">Newest first</span></div><div id="agentRecords" class="agent-list">Loading…</div></div><div><div class="inline-heading"><h3>Actions</h3><span class="hint">Pending and completed</span></div><div id="agentActions" class="agent-list">Loading…</div></div></div>
<div class="agent-memory"><div><div class="inline-heading"><h3>Observed Teams chats</h3></div><div id="agentConversations" class="agent-conversations">Loading…</div></div>
<div><div class="inline-heading"><h3>Freeform notes</h3><button id="agentNotesRefresh" type="button" class="small">Refresh list</button></div><div class="agent-controls"><select id="agentNoteSelect" aria-label="Choose a note"><option value="">No notes loaded</option></select><button id="agentNoteNew" type="button" class="small">New note</button></div><label for="agentNotePath">Note path</label><input id="agentNotePath" placeholder="people/alex.md"><label for="agentNoteText">Note text</label><textarea id="agentNoteText" rows="7" placeholder="Private notes for continuity…"></textarea><div class="form-footer"><span id="agentNoteState" class="save-state"></span><button id="agentNoteSave" type="button" class="small">Save note</button></div></div>
<div><h3>Chat brief</h3><label for="agentBriefChat">Exact chat name</label><div class="agent-controls"><input id="agentBriefChat" placeholder="Select from conversation history or type exact name"><button id="agentBriefLoad" type="button" class="small">Load</button></div><label for="agentBriefText">Brief</label><textarea id="agentBriefText" rows="5" placeholder="Optional context for this person or chat…"></textarea><div class="form-footer"><span id="agentBriefState" class="save-state"></span><button id="agentBriefSave" type="button" class="small">Save brief</button></div></div></div>
</div></section>
<section class="card" aria-labelledby="scheduleHeading"><div class="card-body"><div class="section-title"><h2 id="scheduleHeading">Scheduled Teams actions</h2><button id="refreshSchedules" class="small" type="button">Refresh schedules</button></div><p id="schedulerState" class="hint">Checking orchestrator…</p><div class="schedule-layout"><form id="scheduleForm"><fieldset id="scheduleFields" class="settings-fields"><label for="scheduleKind">Action</label><select id="scheduleKind"><option value="message">Send a message</option><option value="status">Change availability</option></select><div id="scheduleMessageFields"><label for="scheduleChat">Exact Teams chat name</label><input id="scheduleChat" maxlength="300" placeholder="Person or group chat name"><label for="scheduleText">Message</label><textarea id="scheduleText" maxlength="8000" rows="3"></textarea><p class="hint">Uses Teams reply permissions at send time. An empty whitelist blocks all sends. Duplicate chat names or existing drafts are not sent.</p></div><div id="scheduleStatusField" hidden><label for="schedulePresence">Availability</label><select id="schedulePresence"><option value="available">Available</option><option value="away">Appear away</option><option value="offline">Appear offline</option><option value="busy">Busy</option><option value="dnd">Do not disturb</option><option value="brb">Be right back</option></select></div><label for="scheduleWhen">Date and time</label><input id="scheduleWhen" type="datetime-local" required><p id="scheduleTimezone" class="hint"></p><button id="scheduleSubmit" type="submit" class="primary small" disabled>Schedule action</button></fieldset></form><div><div id="schedulePending" class="schedule-queue">Loading schedules…</div><details><summary>Recent results (latest 100)</summary><div id="scheduleHistory" class="schedule-queue"></div></details><p id="scheduleLoadState" class="error-text" role="status"></p></div></div><p class="hint">One-time schedules, saved locally. The orchestrator must be running; actions wait for current handling to finish. Due while stopped or more than five minutes late: missed, not replayed. Interrupted sends: outcome unconfirmed, never automatically retried. Schedule checks continue while live log tailing is paused.</p></div></section>
<section class="card poll-card" aria-label="Latest orchestrator poll"><div class="poll-heading"><div><div class="poll-title"><h2 id="pollStatus">No poll recorded yet</h2></div><p id="pollDetail" class="poll-meta">Waiting for the orchestrator…</p></div><span id="pollBadge" class="badge neutral">Checking</span></div><div class="poll-stats"><div class="stat"><b id="pollChats">—</b><span>Unread chats</span></div><div class="stat"><b id="pollHandled">—</b><span>Messages handled</span></div><div class="stat"><b id="pollDuplicates">—</b><span>Duplicates skipped</span></div><div class="stat"><b id="pollErrors">—</b><span>Errors</span></div></div><div class="poll-foot"><span id="pollExtra">Counts will appear after the first poll.</span><span id="pollNext">Monitor stopped</span></div></section>
<section class="card"><div class="workspace-tabs"><div class="tabs" role="tablist" aria-label="Activity views"><button class="tab active" data-view="activity" role="tab" aria-selected="true" aria-controls="activityView">Message activity</button><button class="tab" data-view="logs" role="tab" aria-selected="false" aria-controls="logsView">System logs</button></div></div><div id="activityView" role="tabpanel"><div class="filterbar"><input id="searchMessages" type="search" placeholder="Search messages, people, or chats…" aria-label="Search messages"><select id="messageFilter" aria-label="Filter messages"><option value="all">All outcomes</option><option value="alarm">Alarms</option><option value="ignore">Ignored</option><option value="error">Errors</option></select></div><div class="feed-grid"><div class="feed-column"><div class="feed-caption"><span>SEEN BY THE ORCHESTRATOR</span><span id="messageCount">0 messages</span></div><div class="activity-clear"><div class="date-filter"><label for="activitySince">After</label><input id="activitySince" type="datetime-local" step="0.001" aria-label="Show messages after date and time" aria-describedby="activityClearState"><button id="clearActivity" class="small" title="Use the highlighted message’s date and hide it and earlier messages" disabled>Use selected message</button><button id="showAllActivity" class="small" disabled>Show all</button></div><p id="activityClearState" class="hint" role="status"></p></div><div id="messages" class="message-list"></div></div><div id="pipeline" class="pipeline" aria-label="Selected message handling stages"></div></div><p class="log-note">Recent retained activity, newest first. Duplicate reads are counted in the poll above.</p></div><div id="logsView" role="tabpanel" hidden><div class="logs-toolbar"><label for="logSource" class="hidden">Log source</label><select id="logSource"><option value="orchestratorLog">Orchestrator output</option><option value="connectionLog">Connections & delivery</option><option value="tunnelLog">Cloudflare tunnel</option><option value="activityLog">All activity · raw events</option></select><button id="copyLog" class="small">Copy log</button></div><pre id="orchestratorLog" class="log-output">Loading…</pre><pre id="connectionLog" class="log-output" hidden></pre><pre id="tunnelLog" class="log-output" hidden></pre><pre id="activityLog" class="log-output" hidden></pre><p class="log-note">Logs refresh every 10 seconds. Pause live log tailing in the top bar to inspect a stable view.</p></div></section><div class="footer-note"><span>Timestamps use your browser’s timezone</span><span></span></div>
</section></div></main><div id="toast" class="toast hidden" role="status"></div><dialog id="login"><form id="loginForm"><div class="eyebrow">TM</div><h2>Dashboard access</h2><p>Enter the access token from your local configuration. It is saved in this browser.</p><label for="tokenInput">Access token</label><input id="tokenInput" type="password" autocomplete="current-password" required><button class="primary">Connect</button></form></dialog>
<script>${filterActivityAfter.toString()}; ${parseActivityDate.toString()}; ${buildActivityGroups.toString()}; ${syncAgentRecordList.toString()}; ${dashboardClient.toString()}; dashboardClient();</script></body></html>`;
