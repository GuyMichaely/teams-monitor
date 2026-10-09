import { invocationViewHTML } from './dashboard-invocations.mjs';
import { renderActionCards } from './dashboard-actions.mjs';
import { logYaml } from './dashboard-yaml.mjs';

// One chronology owns policy, model and action records for the selected event.
export function eventResponseHTML(group, data) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const stamp = at => at ? new Date(at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
  const ms = at => typeof at === 'number' ? at : Date.parse(at) || 0;
  const detail = (key, label, value) => value == null ? '' : `<details data-key="${esc(key)}"><summary>${esc(label)}</summary><pre>${esc(logYaml(value))}</pre></details>`;
  if (!group) return '<div class="empty"><h3>Event response</h3><p>Select a message or reaction to inspect its handling.</p></div>';
  if (group.invalid) return '<div class="empty"><h3>Invalid log format</h3><p>This entry is missing a valid message or handling trace.</p></div>';
  const runs = data?.runs || [], actions = data?.actions || [], steps = [];
  const modelIds = new Set(runs.flatMap(run => (run.invocations || []).map(call => call.runId)));
  const attributes = Object.assign(Object.create(null), group.attributes || {}, ...runs.filter(r => !r.replay).sort((a,b) => ms(a.startedAt)-ms(b.startedAt)).map(r => r.attributes || {}));
  const add = (key, at, title, body, failed = false) => steps.push({ key, at: ms(at), title, body, failed });
  const names = { message:'Observed in Teams', policy:'Reply permissions checked', brain_input:'Model input', brain_output:'Model output', decision:'Policy decision', effect:'Handling result', error:'Handling error' };
  for (const [index, event] of group.events.entries()) {
    if (event.attributes || runs.length && event.source === 'javascript') continue;
    if (['brain_input', 'brain_output'].includes(event.stage) && modelIds.has(event.result?.runId)) continue;
    if (actions.length && event.stage === 'effect' && event.effect !== 'policy_commit') continue;
    const body = event.stage === 'message' ? group.latest?.text : event.reason || event.error || event.detail || event.effect?.replaceAll('_', ' ') || '';
    const extra = event.stage === 'message' ? group.latest : event.ruleActions || event.ruleEvaluations || event.results || event.reply || event.result;
    add('flow:' + index, event.at, event.stage === 'decision' && event.ruleActions ? 'Actions committed' : names[event.stage] || event.stage,
      `<p>${esc(body)}</p>${detail('flow:' + index, event.stage === 'message' ? 'Captured message' : 'Details', extra)}`, event.stage === 'error' || event.status === 'error');
  }
  for (const run of runs) {
    add('policy:' + run.runId, run.startedAt, run.replay ? 'Policy replay' : 'Policy started',
      detail('code:' + run.runId, 'Evaluated TypeScript', run.source) + detail('context:' + run.runId, 'Input variables', run.context));
    for (const update of Array.isArray(run.attributeUpdates) ? run.attributeUpdates : []) {
      if (!update || typeof update !== 'object' || !update.attributes || typeof update.attributes !== 'object') continue;
      add('attributes:' + update.seq, update.at, 'Policy attributes updated', detail('attributes:' + update.seq, 'Calculated values', update.attributes));
    }
    for (const call of run.invocations || []) {
      const duration = call.completedAt ? Math.max(0, (ms(call.completedAt) - ms(call.startedAt)) / 1000).toFixed(1) + ' s' : '';
      add('model:' + call.runId, call.startedAt, 'LLM call · ' + call.status + (duration ? ' · ' + duration : ''), invocationViewHTML({runs:[{...run, source:null, context:null, decision:null, error:null, invocations:[call]}]}), call.status === 'failed');
    }
    if (run.status === 'completed' || run.status === 'failed') add('result:' + run.runId,
      run.completedAt || Math.max(ms(run.startedAt), ...(run.invocations || []).map(call => ms(call.completedAt || call.startedAt))),
      run.replay ? 'Replay ' + run.status : 'Policy ' + run.status,
      detail('result:' + run.runId, 'Return value', run.decision) + (run.error ? `<p class="error-text">${esc(logYaml(run.error))}</p>` : ''), run.status === 'failed');
  }
  for (const action of actions) add('action:' + action.id, action.created, 'Action · ' + (action.value?.kind || 'invalid'), renderActionCards([action]), ['failed','uncertain','invalid'].includes(action.state));
  steps.sort((a,b) => a.at-b.at);
  const failed = group.error || runs.some(r => !r.replay && (r.error || r.invocations?.some(c => c.status === 'failed')));
  const summary = failed ? 'Handling includes an error' : !group.done ? 'Handling in progress / incomplete' : actions.length ? actions.length + (actions.length === 1 ? ' action' : ' actions') : 'No action';
  return `<div class="event-response-heading"><span class="eyebrow">SELECTED ${group.latest?.reaction ? 'REACTION' : 'MESSAGE'}</span><h3>${esc(group.chat)}</h3><p>${esc(group.latest?.author)} · ${esc(stamp(group.at))}</p><p class="${failed ? 'error-text' : ''}">${esc(summary)}</p></div>` +
    (Object.keys(attributes).length ? `<h3>Policy attributes</h3><dl class="attribute-table">${Object.entries(attributes).map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value === null ? 'null' : value)}</dd>`).join('')}</dl>` : '') +
    `<h3>Response timeline</h3><ol class="response-timeline">${steps.map(step=>`<li class="response-step ${step.failed?'failed':''}" data-response-key="${esc(step.key)}"><header><strong>${esc(step.title)}</strong><time>${esc(stamp(step.at))}</time></header>${step.body}</li>`).join('')}</ol>` +
    (!data ? '<p class="hint event-model-state">Loading model calls and actions…</p>' : !runs.length ? '<p class="hint">No policy invocation is recorded for this event.</p>' : '') +
    (group.latest?.author && !group.latest.reaction ? `<button class="small event-edit-note" data-person-note="${esc(group.latest.author)}">Edit ${esc(group.latest.author)}’s note</button>` : '');
}
