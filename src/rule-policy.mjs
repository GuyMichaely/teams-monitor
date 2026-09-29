import { evaluateRules, validateAutomation, validateAction } from './deterministic-rules.mjs';

async function emit(trace, key, value) {
  try { await trace?.[key]?.(value); } catch { /* Observability cannot grant or revoke action permission. */ }
}

// Validate everything before applying anything. Invalid plans retain configured
// actions, just like an unavailable model; they never acquire new authority.
export function applyAgentPlan(plan, proposals, permissions, replyAllowed) {
  if (!plan || !Array.isArray(plan.changes) || !Array.isArray(plan.additions) || typeof plan.reason !== 'string' || !plan.reason.trim() || Object.keys(plan).some(k => !['changes', 'additions', 'reason'].includes(k)) || plan.changes.length > 100 || plan.additions.length > 10) throw new Error('Invalid agent plan');
  const next = structuredClone(proposals), changed = new Set();
  for (const change of plan.changes) {
    if (!change || typeof change.reason !== 'string' || !change.reason.trim() || !['cancel', 'modify'].includes(change.operation) || Object.keys(change).some(k => !['ruleId', 'operation', 'action', 'reason'].includes(k))) throw new Error('Invalid agent change');
    const proposal = next.find(p => p.ruleId === change.ruleId);
    if (!proposal || changed.has(change.ruleId) || proposal.outcome === 'blocked_reply_policy') throw new Error('Agent targeted an unknown, repeated or blocked rule');
    changed.add(change.ruleId);
    if (!proposal.permissions[change.operation]) throw new Error(`Agent lacks ${change.operation} permission for ${change.ruleId}`);
    if (change.operation === 'cancel') {
      if (change.action !== undefined) throw new Error('Cancellation cannot introduce an action');
      proposal.outcome = 'cancelled';
    } else {
      const action = validateAction(change.action);
      if (action.type !== proposal.action.type || action.type === 'ignore') throw new Error('Modification cannot change action type or target');
      if (action.type === 'reply' && !replyAllowed) throw new Error('Reply policy blocks agent modification');
      proposal.action = action; proposal.outcome = 'modified';
    }
    proposal.reason = change.reason;
  }
  for (const [index, addition] of plan.additions.entries()) {
    if (!addition || typeof addition.reason !== 'string' || !addition.reason.trim() || Object.keys(addition).some(k => !['action', 'reason'].includes(k))) throw new Error('Invalid agent addition');
    const action = validateAction(addition.action);
    if (!permissions.includes(action.type) || (action.type === 'reply' && !replyAllowed)) throw new Error(`Agent may not initiate ${action.type}`);
    next.push({ ruleId: `agent:${index}`, action, outcome: 'initiated', reason: addition.reason, permissions: { cancel: false, modify: false } });
  }
  return next.map(p => p.outcome === 'proposed' ? { ...p, outcome: 'retained' } : p);
}

export async function decideWithRules(input, brain, trace = {}) {
  const automation = validateAutomation(input.config?.automation);
  const evaluations = evaluateRules(input);
  const matches = evaluations.filter(e => e.matched);
  let actions = matches.map(({ rule }) => ({ ruleId: rule.id, action: rule.action, permissions: rule.agent,
    outcome: rule.action.type === 'reply' && !input.whitelisted ? 'blocked_reply_policy' : 'proposed', reason: `Rule ${rule.id} matched` }));
  await emit(trace, 'onRules', { evaluations, matchedRuleIds: matches.map(e => e.rule.id) });
  const policy = automation.agent.initiate;
  const initiationAllowed = policy.when === 'always' || (policy.when === 'unmatched' && !matches.length);
  const allowedAdditions = initiationAllowed ? policy.actions.filter(t => t !== 'reply' || input.whitelisted) : [];
  const reviewNeeded = allowedAdditions.length || actions.some(p => p.outcome !== 'blocked_reply_policy' && (p.permissions.cancel || (p.permissions.modify && p.action.type !== 'ignore')));
  if (!reviewNeeded) {
    actions = actions.map(p => ({ ...p, outcome: p.outcome === 'proposed' ? 'bypassed' : p.outcome }));
    await emit(trace, 'onInput', { provider: 'rules', skipped: true, reason: 'LLM bypassed: no applicable agent permissions', proposals: actions });
  } else {
    const controller = new AbortController();
    let active = true, timer;
    const boundedTrace = Object.fromEntries(['onInput', 'onOutput'].map(key => [key, payload => active ? emit(trace, key, payload) : undefined]));
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { const error = new Error(`Agent review timed out after ${automation.agent.timeoutMs}ms`); controller.abort(error); reject(error); }, automation.agent.timeoutMs);
      });
      const plan = await Promise.race([
        Promise.resolve().then(() => brain.reviewPlan({ ...input, rulePlan: { evaluations, proposals: structuredClone(actions), allowedAdditions, replyAllowed: !!input.whitelisted }, signal: controller.signal }, boundedTrace)), timeout,
      ]);
      actions = applyAgentPlan(plan, actions, allowedAdditions, input.whitelisted);
    } catch (error) {
      active = false; controller.abort();
      actions = actions.map(p => ({ ...p, outcome: p.outcome === 'proposed' ? 'fallback' : p.outcome }));
      await emit(trace, 'onReviewError', { error: error?.message || String(error), recovered: true, proposedActions: actions });
    } finally { active = false; clearTimeout(timer); controller.abort(); }
  }
  const decision = { action: 'rule_actions', reply: null, invokeActions: [], reason: `${matches.length} rule(s) matched`, ruleActions: actions, ruleEvaluations: evaluations };
  await emit(trace, 'onDecision', { decision });
  return decision;
}
