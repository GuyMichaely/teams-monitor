import './agentic-dev-env.mjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Usage } from '@openai/agents';
import { loadConfig } from '../src/context.mjs';
import { runAgent, agentTool } from '../src/agent/runtime.mjs';

const live = process.argv.slice(2).includes('--live');
if (process.argv.slice(2).some(arg => arg !== '--live')) throw new Error('Usage: bun run agent:sdk [--live]');
const marker = randomUUID();
let calls = 0;
const probe = agentTool({
  name: 'read_probe', description: 'Read the harmless local SDK test marker.', parameters: z.object({}),
  execute: () => { calls++; return { ok: true, marker }; },
});
const mock = {
  async getResponse(request) {
    const result = Array.isArray(request.input) && request.input.find(i => i.type === 'function_call_result');
    return { usage: new Usage({ requests: 1 }), output: result
      ? [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.parse(typeof result.output === 'string' ? result.output : result.output.text).marker }] }]
      : [{ type: 'function_call', name: 'read_probe', callId: 'probe', arguments: '{}' }] };
  },
};
const result = await runAgent({
  config: await loadConfig(), model: live ? undefined : mock, tools: [probe],
  modelSettings: { toolChoice: 'required' },
  instructions: 'Call read_probe exactly once. Return only the marker it returns, without quotes or commentary. There are no other tasks or tools.',
  input: 'Read the probe marker.',
});
if (!result.ok) { console.error(JSON.stringify(result)); process.exitCode = 1; }
else if (calls !== 1 || result.output?.trim() !== marker) { console.error(JSON.stringify({ ok: false, error: 'SDK probe did not complete the required tool/result round trip.', toolCalls: calls, modelRequests: result.usage.requests })); process.exitCode = 1; }
else console.log(JSON.stringify({ ok: true, mode: live ? 'gemini' : 'mock', runId: result.runId, toolCalls: calls, modelRequests: result.usage.requests }));
