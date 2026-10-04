// Inspect retained runs without invoking a model or creating continuation history.
export function messageInvocations(store, messageId, current) {
  let budget = 1_000_000;
  const bound = value => {
    if (value === undefined) return null;
    const json = JSON.stringify(value);
    const limit = Math.max(0, Math.min(200_000, budget));
    if (json.length <= limit) { budget -= json.length; return value; }
    const excerpt = json.slice(0, Math.min(60_000, limit)); budget -= excerpt.length;
    return { truncated: true, excerpt };
  };
  const object = row => row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : null;
  const last = (rows, kind) => rows.findLast(row => row.kind === kind);
  const runs = store.messageRuns(messageId).map(({ policy, models }) => {
    const first = last(policy, 'policy_input'), input = object(first);
    const done = last(policy, 'policy_result'), failed = last(policy, 'policy_failed');
    const grouped = new Map();
    for (const row of models) {
      if (!grouped.has(row.runId)) grouped.set(row.runId, []);
      grouped.get(row.runId).push(row);
    }
    const active = current?.runId === first?.runId;
    return {
      runId: first?.runId, startedAt: first?.at, replay: !!input?.replay,
      status: done ? 'completed' : failed ? 'failed' : active ? 'running' : 'incomplete',
      context: bound(input?.context), source: bound(input?.source),
      decision: bound(object(done)?.value), error: bound(object(failed)?.error),
      invocations: [...grouped].map(([runId, rows]) => {
        const requestRow = last(rows, 'agent_input'), request = object(requestRow);
        const resultRow = last(rows, 'agent_result'), result = object(resultRow);
        const terminal = last(rows, 'run_failed') || last(rows, 'run_completed');
        return {
          runId, startedAt: requestRow?.at ?? rows[0]?.at,
          completedAt: resultRow?.at ?? terminal?.at ?? null,
          status: result ? (result.ok ? 'completed' : 'failed') : terminal?.kind === 'run_failed' ? 'failed' : terminal?.kind === 'run_completed' ? 'completed' : active ? 'running' : 'incomplete',
          conversationId: request?.conversationId ?? result?.conversationId ?? null,
          input: bound(request?.input), instructions: bound(request?.instructions), permissions: bound(request?.permissions),
          history: bound(result?.history), output: bound(result?.output), error: bound(result?.error ?? object(terminal)?.error),
          events: rows.filter(row => !['agent_input', 'agent_result'].includes(row.kind)).slice(-100).map(row => ({
            seq: row.seq, at: row.at, kind: object(row) ? row.kind : 'invalid_log', value: bound(object(row) ?? { error: 'Invalid log format' }),
          })),
        };
      }).sort((a, b) => a.startedAt - b.startedAt),
    };
  });
  return { messageId, runs };
}
