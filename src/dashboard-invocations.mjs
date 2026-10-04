export function invocationViewHTML(data) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const time = at => at ? new Date(at).toLocaleString() : '—';
  const detail = (key, label, value) => value == null ? '' : `<details data-invocation-key="${escape(key)}"><summary>${escape(label)}${value?.truncated ? ' · truncated' : ''}</summary><pre>${escape(pretty(value))}</pre></details>`;
  const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text || '').filter(Boolean).join('\n') : '';
  const transcript = (items, key) => Array.isArray(items) ? items.map((item, index) => {
    if (!item || typeof item !== 'object') return detail(key + index, 'Invalid log format', item);
    if (item.type === 'function_call') return detail(key + index, 'Tool call · ' + item.name, item);
    if (item.type === 'function_call_result') return detail(key + index, 'Tool result', item);
    const content = text(item.content);
    if (!content) return detail(key + index, item.type || 'Record', item);
    let request;
    if (item.role === 'user') { try { request = JSON.parse(content); } catch {} }
    const label = typeof request?.prompt === 'string' ? 'Policy request' : item.role === 'assistant' ? 'Assistant' : item.role || 'Message';
    return `<div class="invocation-turn ${item.role === 'assistant' ? 'assistant-turn' : ''}"><strong>${escape(label)}</strong><pre>${escape(request?.prompt ?? content)}</pre>${request?.prompt ? detail(key + index, 'Full request data · context, code and permissions', request) : ''}</div>`;
  }).join('') : detail(key, 'Recorded transcript', items);
  if (!data?.runs?.length) return '<p class="hint">No policy invocation recorded for this message.</p>';
  return data.runs.map(run => {
    const decision = run.decision;
    const decisionText = typeof decision?.alert === 'boolean' ? `Policy decision: ${decision.alert ? 'Alert' : 'No alert'} · ${decision.decidedBy === 'llm' ? 'LLM' : 'Deterministic fallback'}${typeof decision.deterministicAlert === 'boolean' ? ' · heuristic: ' + (decision.deterministicAlert ? 'alert' : 'no alert') : ''}` : '';
    return `<section class="invocation-policy"><p class="invocation-decision">${escape(decisionText || (run.replay ? 'Policy replay' : 'Policy invocation'))}${run.replay && decisionText ? ' · replay' : ''}</p>${run.error ? `<p class="error-text">${escape(pretty(run.error))}</p>` : ''}${run.invocations.map(call => {
      const history = Array.isArray(call.history) ? call.history : call.input;
      return `<details class="invocation-call" data-invocation-key="call:${escape(call.runId)}" open><summary>${escape(time(call.startedAt))} · ${escape(call.status)} · ${escape(call.conversationId || 'Fresh call')}</summary>${call.error ? `<p class="error-text">${escape(call.error.code || 'Model failed')} · ${escape(call.error.message || '')}</p>` : ''}${detail('instructions:' + call.runId, 'System instructions', call.instructions)}<div class="invocation-transcript">${transcript(history, 'turn:' + call.runId + ':')}${!Array.isArray(call.history) && call.output != null ? `<div class="invocation-turn assistant-turn"><strong>Assistant</strong><pre>${escape(pretty(call.output))}</pre></div>` : ''}</div>${!history ? '<p class="hint">No request transcript was saved for this call.</p>' : ''}${detail('permissions:' + call.runId, 'Granted permissions', call.permissions)}${detail('events:' + call.runId, 'Execution log · tools, timing and errors', call.events)}${call.history?.truncated ? detail('history:' + call.runId, 'Transcript excerpt', call.history) : ''}</details>`;
    }).join('') || '<p class="hint">This policy did not record an LLM call.</p>'}${detail('code:' + run.runId, 'Evaluated policy code', run.source)}${detail('context:' + run.runId, 'Policy input context', run.context)}${detail('decision:' + run.runId, 'Policy result', run.decision)}</section>`;
  }).join('');
}
