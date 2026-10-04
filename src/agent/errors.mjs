import { NotificationPayloadError } from '../phone-notification.mjs';

export class AgentRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.details = details;
  }
}

export function failure(error, { aborted = false, timedOut = false } = {}) {
  let code = 'AGENT_FAILED', message = 'Agent run failed.';
  if (timedOut) { code = 'TIMEOUT'; message = 'Agent run exceeded its deadline.'; }
  else if (aborted) { code = 'CANCELLED'; message = 'Agent run was cancelled.'; }
  else if (error instanceof AgentRuntimeError || error instanceof NotificationPayloadError) { code = error.code; message = error.message; }
  else if (error?.name === 'MaxTurnsExceededError') { code = 'TURN_LIMIT'; message = 'Agent run reached its model-turn limit.'; }
  else if (error?.name === 'ModelBehaviorError') { code = 'INVALID_MODEL_OUTPUT'; message = 'Model returned an invalid or unavailable tool call.'; }
  // Provider errors can contain credentials, prompts or message bodies.
  return { ok: false, error: { code, message, ...(error instanceof AgentRuntimeError ? error.details : {}) } };
}
