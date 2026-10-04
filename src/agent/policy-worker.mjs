import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

let nonce;
const emit = value => new Promise(resolve => process.stdout.write('TM_RPC:' + nonce + ':' + JSON.stringify(value) + '\n', resolve));
let sequence = 0;
const pending = new Map();
const lines = createInterface({ input: process.stdin });
const call = (method, args) => new Promise(resolve => {
  const id = ++sequence; pending.set(id, resolve); emit({ type: 'call', id, method, args });
});
lines.on('line', async line => {
  let item;
  try { item = JSON.parse(line); } catch { return; }
  if (item.type === 'reply') { pending.get(item.id)?.(item.result); pending.delete(item.id); return; }
  if (item.type !== 'start') return;
  nonce = item.nonce;
  try {
    const policy = await import(pathToFileURL(item.path).href);
    if (typeof policy.handle !== 'function' || ['onWake', 'onIntervention', 'onActionResult'].some(key => policy[key] !== undefined && typeof policy[key] !== 'function')) throw Error('Invalid exports');
    if (item.validate) { await emit({ type: 'done', ok: true }); process.exit(0); }
    const actions = Object.fromEntries(['readReactions', 'sendMessage', 'alert', 'setStatus', 'delay', 'cancel', 'modify', 'wake', 'llm'].map(name => [name, (...args) => call(name, args)]));
    const handler = policy[item.handler] || (['onWake', 'onIntervention'].includes(item.handler) ? (ctx, api) => api.llm(ctx.prompt, { ...ctx.ceiling, conversationId: ctx.conversationId }) : null);
    const value = handler ? await handler(item.context, actions) : null;
    if (pending.size) throw Error('Unawaited action calls');
    await emit({ type: 'done', ok: true, value }); process.exit(0);
  } catch (error) {
    const locations = String(error.stack || '').split('\n').slice(1).map(line => line.match(/(?:file:\/\/\/)?([^()]+\.(?:mjs|ts):\d+:\d+)/)?.[1]?.trim()).filter(Boolean).slice(0, 8);
    await emit({ type: 'done', ok: false, error: { code: 'POLICY_FAULT', message: 'Policy threw, has invalid exports, or left unawaited actions.', locations } }); process.exit(1);
  }
});
