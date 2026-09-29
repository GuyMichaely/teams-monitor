import { buildActivityGroups } from "./dashboard-activity.mjs";
// One page owns presentation and refresh state; the existing authenticated APIs own controls.
function dashboardClient() {
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const time = (at) => at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  const age = (at) => { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000)); return seconds < 60 ? seconds + "s ago" : seconds < 3600 ? Math.floor(seconds / 60) + "m ago" : Math.floor(seconds / 3600) + "h ago"; };
  const pretty = (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const badge = (text, tone = "neutral") => `<span class="badge ${tone}">${escape(text)}</span>`;
  let token = localStorage.guiToken || "";
  let overview, runtime, health, diagnostics, poll, tunnel;
  let presenceChanging = false, presenceRevision = 0;
  let activityClearing = false, clearedThrough = null, activityGeneration = 0;
  let items = [], groups = [], selected = null, lastSuccess = null, paused = false, refreshing = false, slowAt = 0;
  let deliveryReady = false, policyReady = false, profileReady = false, rulesReady = false;
  let deliveryDirty = false, policyDirty = false, profileDirty = false, pollDirty = false, rulesDirty = false;
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
  async function perform(button, work, message) {
    button.disabled = true;
    try { await work(); notify(message); slowAt = 0; await refresh(true); }
    catch (e) { notify(e.message, true); }
    finally { button.disabled = false; renderStatus(); }
  }
  function renderStatus() {
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
  function groupMessages() { groups = buildActivityGroups(items); }
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
    $('clearActivity').disabled = activityClearing || !groups.find(g => g.id === selected)?.at;
    if (!activityClearing && document.activeElement !== $('activitySince')) syncDateFilter();
    setText('activityClearState', clearedThrough ? 'Showing messages after ' + time(clearedThrough) + '. Logs are not deleted.' : 'Showing all retained messages. Logs are not deleted.');
    setText('messageCount', filtered.length + (filtered.length === 1 ? ' message' : ' messages'));
    const fingerprint = JSON.stringify([filtered, selected]);
    const selection = window.getSelection();
    if (!selection?.isCollapsed && $('messages').contains(selection?.anchorNode)) return;
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
      return `<li class="stage ${event.stage === 'error' || event.status === 'error' ? 'failed' : ''}"><span class="stage-dot">${index + 1}</span><div class="stage-title"><strong>${escape(event.source === 'rules' ? 'Configured rules evaluated' : event.source === 'rule_review' ? 'LLM review failed · configured actions retained' : names[event.stage] || event.stage)}</strong><span>+${escape(seconds)}s</span></div><time>${escape(time(event.at))}</time>${event.action ? badge(event.action) : ''}<p>${escape(body)}</p>${details ? `<details data-key="${escape(key)}" ${open.includes(key) ? 'open' : ''}><summary>${event.stage === 'brain_input' ? 'View exact brain input' : 'View details'}</summary><pre>${escape(pretty(details))}</pre></details>` : ''}</li>`;
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
        readPart('Messages', '/api/activity?limit=500', (v) => { if (generation === activityGeneration) { items = v; groupMessages(); } }),
        readPart('Activity view', '/api/activity/view', (v) => { if (generation === activityGeneration) clearedThrough = v.clearedThrough; }),
      ]);
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
        rulesReady ? null : readPart('Alert rules', '/api/policy/automation/yaml', (v) => { $('alertRules').value = v.yaml; rulesReady = true; $('ruleFields').disabled = false; }),
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
  $('refreshButton').onclick = () => refresh(true);
  function localDateTime(at) { const d = new Date(at); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, -1); }
  function syncDateFilter() { $('hideOlder').checked = !!clearedThrough; if (clearedThrough) $('activitySince').value = localDateTime(clearedThrough); }
  async function changeActivityView(through) {
    if (activityClearing) return;
    activityClearing = true; activityGeneration++;
    $('clearActivity').disabled = true; $('hideOlder').disabled = true; $('activitySince').disabled = true;
    try {
      const view = await api('/api/activity/view', 'PUT', { through });
      // Invalidate any refresh that started while the request was pending too.
      activityGeneration++; clearedThrough = view.clearedThrough;
      items = await api('/api/activity?limit=500'); selected = null;
      groupMessages(); renderMessages(true); renderFlow(true); renderLogs(logData);
      notify(through ? 'Message date filter updated' : 'Showing all retained messages');
    } catch (e) { notify(e.message, true); }
    finally { activityClearing = false; $('hideOlder').disabled = false; $('activitySince').disabled = false; syncDateFilter(); renderMessages(true); }
  }
  $('clearActivity').onclick = () => { const at = groups.find(g => g.id === selected)?.at; if (at) { $('activitySince').value = localDateTime(at); changeActivityView(at); } };
  function applyDateFilter() {
    if (!$('hideOlder').checked) return changeActivityView(null);
    const value = $('activitySince').value;
    if (!value || !Number.isFinite(new Date(value).getTime()) || !$('activitySince').checkValidity()) { notify('Choose a valid date and time', true); return; }
    changeActivityView(new Date(value).toISOString());
  }
  $('hideOlder').onchange = applyDateFilter;
  $('activitySince').onchange = () => { $('hideOlder').checked = !!$('activitySince').value; applyDateFilter(); };
  for (const [id, path, text] of [['startOrch', '/api/start', 'Orchestrator starting'], ['stopOrch', '/api/stop', 'Orchestrator stop requested'], ['startTunnel', '/api/tunnel/start', 'Tunnel starting'], ['stopTunnel', '/api/tunnel/stop', 'Tunnel stopped']]) {
    $(id).onclick = () => {
      if (id === 'stopTunnel' && !confirm('Stop the public tunnel? Remote dashboard access and phone WebSocket delivery will disconnect.')) return;
      if (id === 'startOrch' && $('phoneHealth').textContent === 'Needs attention' && !confirm('Phone delivery needs attention. Start monitoring anyway? Alerts may not reach your phone.')) return;
      perform($(id), () => api(path, 'POST'), text);
    };
  }
  $('pollInterval').oninput = () => { pollDirty = true; setText('pollSaveState', 'Unsaved'); };
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
  $('rulesForm').onsubmit = (e) => { e.preventDefault(); if (!rulesReady) return; perform($('ruleFields'), async () => { const saved = await api('/api/policy/automation/yaml', 'PUT', { yaml: $('alertRules').value }); $('alertRules').value = saved.yaml; rulesDirty = false; setText('rulesSaveState', 'Saved'); }, 'Automation config saved for the next poll'); };
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
  window.addEventListener('beforeunload', (e) => { if (deliveryDirty || policyDirty || profileDirty || pollDirty || rulesDirty) { e.preventDefault(); e.returnValue = ''; } });
  policySummary(); refresh(true);
  setInterval(() => refresh(), 2000);
  setInterval(() => { if (!paused) renderPoll(); }, 1000);
}

export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Teams Monitor — Dashboard</title>
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
</style></head><body>
<header><div class="brand"><span class="brandmark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Teams Monitor <span class="workspace-label">/ LOCAL CONTROL</span></div><div class="header-right"><span id="lastRefresh" class="sync-time">Waiting for server</span><button id="pauseUpdates" class="live-toggle warn" aria-pressed="true" title="Connecting · Pause live log tailing">Pause live log tailing</button><button id="refreshButton" title="Manually sync tail" aria-label="Manually sync tail">↻</button><button id="accountButton">Access token</button></div></header>
<main class="shell">
<div id="connectionError" class="connection-error" role="alert" hidden></div><div id="attention" class="notice" hidden><span class="notice-icon">!</span><div><strong>Setup required</strong><span id="attentionText"></span></div></div>
<div class="workspace"><aside class="sidebar" aria-label="Controls and settings">
<section class="card"><div class="card-body"><div class="section-title"><h2>Runtime controls</h2></div>
<div class="runtime-row"><div class="runtime-name">Teams orchestrator</div><span id="orchStatus" class="badge neutral">Checking</span></div><p id="orchDetail" class="runtime-detail">Checking heartbeat…</p><div class="button-row"><button id="startOrch" class="primary small" disabled>▶ Start monitor</button><button id="stopOrch" class="small danger" disabled>Stop</button></div>
<form id="pollForm"><label for="pollInterval">Time between Teams polls</label><div class="poll-setting"><input id="pollInterval" type="number" min="1" max="300" step="1" required aria-label="Poll interval in seconds"><span>seconds</span><button id="savePoll" class="small">Save</button><span id="pollSaveState" class="save-state"></span></div></form>
<hr class="divider"><div class="runtime-name">Teams availability</div><label id="presenceLabel" for="presenceSelect" aria-live="polite">Set status</label><select id="presenceSelect"><option value="available">Available</option><option value="away">Appear away</option><option value="offline">Appear offline</option><option value="busy">Busy</option><option value="dnd">Do not disturb</option><option value="brb">Be right back</option><option value="" disabled>Unknown / unavailable</option></select>
<hr class="divider"><div class="runtime-row"><div class="runtime-name">Cloudflare tunnel</div><span id="tunnelStatus" class="badge neutral">Checking</span></div><p id="tunnelDetail" class="runtime-detail">Remote access to this laptop</p><div class="button-row"><button id="startTunnel" class="small" disabled>Start tunnel</button><button id="stopTunnel" class="small danger" disabled>Stop</button></div></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Phone delivery</h2></div><form id="deliveryForm"><label for="deliveryMethod">Preferred delivery method</label><select id="deliveryMethod"><option value="fcm">FCM</option><option value="websocket">Websocket</option></select><label class="check"><input id="fallbackEnabled" type="checkbox">Use the other method if delivery fails</label><div class="form-footer"><span id="deliverySaveState" class="save-state"></span><button id="saveDelivery" class="small">Save delivery</button></div></form><p id="deliveryHint" class="hint">Checking phone delivery…</p><p id="activeTransport" class="hint"></p><details><summary>Setup & recovery details</summary><div id="setupDetails"></div></details></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>System health</h2></div><div class="health-row"><span class="health-name"><span class="health-symbol">◈</span>Teams connection</span><span id="teamsHealth" class="badge neutral">Checking</span></div><div class="health-row"><span class="health-name"><span class="health-symbol">◎</span>Phone delivery</span><span id="phoneHealth" class="badge neutral">Checking</span></div><div class="health-row"><span class="health-name"><span class="health-symbol">◇</span>Brain</span><span id="brainHealth" class="badge neutral">Checking</span></div><div class="health-row"><span>Phone WebSocket</span><span id="wsHealth" class="badge neutral">Checking</span></div><div class="health-row"><span>Public tunnel probe</span><span id="publicHealth" class="badge neutral">Checking</span></div><p id="brainModel" class="hint"></p><p class="hint">Teams can connect when the monitor starts. FCM send acceptance does not confirm phone receipt.</p></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Teams reply permissions</h2></div><p class="hint">Controls outgoing Teams replies, including holding messages. Phone alerts are unaffected.</p><form id="policyForm"><label for="replyMode">Permission mode</label><select id="replyMode"><option value="whitelist">Whitelist · only listed chats</option><option value="blacklist">Blacklist · all except listed chats</option></select><label for="replyEntries">Chat names, one per line</label><textarea id="replyEntries" rows="4" placeholder="e.g. Project chat&#10;Alex Morgan"></textarea><p class="hint">Exact chat names, case-insensitive. No wildcards.</p><p id="policyHint" class="hint"></p><div class="form-footer"><span id="policySaveState" class="save-state"></span><button id="savePolicy" class="small">Save permissions</button></div></form><p class="hint">Default: an empty whitelist allows replies to nobody.</p></div></section>
<section class="card"><div class="card-body"><div class="section-title"><h2>Brain context</h2></div><p class="hint">Instructions used by the brain for phone alerts and permitted Teams replies.</p><form id="profileForm"><label for="brainContext">Context & instructions</label><textarea id="brainContext" class="brain-text" rows="8" placeholder="Enter monitoring context and alert instructions…"></textarea><div class="form-footer"><span id="profileSaveState" class="save-state"></span><button id="saveProfile" class="small">Save context</button></div></form><p class="hint">Saved locally and picked up on the next poll.</p></div></section>
<section class="card" aria-labelledby="advancedTitle"><div class="card-body"><div class="section-title"><h2 id="advancedTitle">Advanced alert rules</h2></div>
<p class="hint">All matching rules propose actions. Each rule's agent.cancel and agent.modify permissions control whether the LLM can cancel it or change its text. Both default to false; modification cannot change action type or destination.</p>
<p class="hint">agent.initiate controls new LLM actions: when is never, unmatched, or always; actions lists alert_phone and/or reply. Enter the automation mapping itself below, without an outer automation key. Quote string values that look like numbers. Saving normalizes YAML and removes comments.</p>
<form id="rulesForm"><fieldset id="ruleFields" class="settings-fields" disabled><label for="alertRules">Automation config YAML</label><textarea id="alertRules" class="code-input" rows="22" spellcheck="false"></textarea><div class="form-footer"><span id="rulesSaveState" class="save-state" aria-live="polite"></span><button id="saveRules" class="small">Save automation config</button></div></fieldset></form>
<p class="hint">Conditions: type direct_message, mention, or reaction; or field text/author/chat with match exact/contains and value. Text also supports contains_number. Combine conditions with all or any arrays. Actions: alert_phone, reply (requires text), or ignore (no action for that rule). Reaction changes are synthetic messages, not new direct messages or mentions.</p>
<p class="hint">The LLM sees rule definitions, tested values, results, proposed actions and permissions. On review failure or timeoutMs expiry, original rule actions run unchanged; no LLM additions run. Identical actions are attempted once. Teams replies always require reply permission. Saves apply next poll.</p></div></section>
</aside><section class="main-column" aria-label="Live monitoring">
<section class="card poll-card" aria-label="Latest orchestrator poll"><div class="poll-heading"><div><div class="poll-title"><h2 id="pollStatus">No poll recorded yet</h2></div><p id="pollDetail" class="poll-meta">Waiting for the orchestrator…</p></div><span id="pollBadge" class="badge neutral">Checking</span></div><div class="poll-stats"><div class="stat"><b id="pollChats">—</b><span>Unread chats</span></div><div class="stat"><b id="pollHandled">—</b><span>Messages handled</span></div><div class="stat"><b id="pollDuplicates">—</b><span>Duplicates skipped</span></div><div class="stat"><b id="pollErrors">—</b><span>Errors</span></div></div><div class="poll-foot"><span id="pollExtra">Counts will appear after the first poll.</span><span id="pollNext">Monitor stopped</span></div></section>
<section class="card"><div class="workspace-tabs"><div class="tabs" role="tablist" aria-label="Activity views"><button class="tab active" data-view="activity" role="tab" aria-selected="true" aria-controls="activityView">Message activity</button><button class="tab" data-view="logs" role="tab" aria-selected="false" aria-controls="logsView">System logs</button></div></div><div id="activityView" role="tabpanel"><div class="activity-clear"><div class="date-filter"><label class="check"><input id="hideOlder" type="checkbox">Hide messages at or before</label><input id="activitySince" type="datetime-local" step="0.001" aria-label="Hide messages at or before date and time"><button id="clearActivity" class="small" disabled>Hide through selected message</button></div><p id="activityClearState" class="hint"></p></div><div class="filterbar"><input id="searchMessages" type="search" placeholder="Search messages, people, or chats…" aria-label="Search messages"><select id="messageFilter" aria-label="Filter messages"><option value="all">All outcomes</option><option value="alarm">Alarms</option><option value="ignore">Ignored</option><option value="error">Errors</option></select></div><div class="feed-grid"><div class="feed-column"><div class="feed-caption"><span>SEEN BY THE ORCHESTRATOR</span><span id="messageCount">0 messages</span></div><div id="messages" class="message-list"></div></div><div id="pipeline" class="pipeline" aria-label="Selected message handling stages"></div></div><p class="log-note">Recent retained activity, newest first. Duplicate reads are counted in the poll above.</p></div><div id="logsView" role="tabpanel" hidden><div class="logs-toolbar"><label for="logSource" class="hidden">Log source</label><select id="logSource"><option value="orchestratorLog">Orchestrator output</option><option value="connectionLog">Connections & delivery</option><option value="tunnelLog">Cloudflare tunnel</option><option value="activityLog">All activity · raw events</option></select><button id="copyLog" class="small">Copy log</button></div><pre id="orchestratorLog" class="log-output">Loading…</pre><pre id="connectionLog" class="log-output" hidden></pre><pre id="tunnelLog" class="log-output" hidden></pre><pre id="activityLog" class="log-output" hidden></pre><p class="log-note">Logs refresh every 10 seconds. Pause live log tailing in the top bar to inspect a stable view.</p></div></section><div class="footer-note"><span>Timestamps use your browser’s timezone</span><span></span></div>
</section></div></main><div id="toast" class="toast hidden" role="status"></div><dialog id="login"><form id="loginForm"><div class="eyebrow">TEAMS MONITOR</div><h2>Dashboard access</h2><p>Enter the access token from your local configuration. It is saved in this browser.</p><label for="tokenInput">Access token</label><input id="tokenInput" type="password" autocomplete="current-password" required><button class="primary">Connect</button></form></dialog>
<script>${buildActivityGroups.toString()}; ${dashboardClient.toString()}; dashboardClient();</script></body></html>`;
