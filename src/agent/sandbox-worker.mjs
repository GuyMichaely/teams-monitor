// This worker and all generated code run INSIDE the native LPAC/job boundary.
import { createInterface } from 'node:readline';
import { inspect } from 'node:util';
import { readFile, appendFile } from 'node:fs/promises';

// Creation attributes are mandatory; these functional checks also reject a
// platform where ALL_APPLICATION_PACKAGES access/profile writes still work.
const denied = async operation => {
  try { await operation(); return false; } catch (error) { return ['EACCES', 'EPERM'].includes(error.code); }
};
if (!await denied(() => readFile('app-packages-canary.txt')) ||
    !await denied(() => appendFile(process.env.TM_SANDBOX_PROFILE + '/write-canary.txt', 'must-not-write'))) process.exit(2);
delete process.env.TM_SANDBOX_PROFILE;

// Windows needs the host LocalAppData root to locate the container during creation;
// guest code receives only the protected bundle location as its profile paths.
process.env.LOCALAPPDATA = process.cwd();

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let serial = 0, started = false;
const pending = new Map();
const call = (name, args) => new Promise(resolve => {
  const id = ++serial;
  pending.set(id, resolve);
  emit({ kind: 'call', id, name, args });
});
// Console output is data, never a host control command. Raw writes are also bounded by the helper.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = (...args) => emit({ kind: 'log', text: args.map(a => typeof a === 'string' ? a : inspect(a, { depth: 3 })).join(' ') });
const handleId = h => typeof h === 'string' ? h : h?.id;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let item; try { item = JSON.parse(line); } catch { process.exit(1); }
  if (item.kind === 'reply') { pending.get(item.id)?.(item.result); pending.delete(item.id); return; }
  if (item.kind !== 'start' || started) return;
  started = true;
  void (async () => {
    try {
      const tools = Object.fromEntries(item.tools.map(name => [name, args => call(name, args || {})]));
      const actions = {
        sendMessage: (chat, text) => call('send_message', { chat, text }),
        alert: text => call('alert', { text }),
        setStatus: presence => call('set_status', { presence }),
        cancel: h => call('cancel_action', { id: handleId(h) }),
        modify: (h, changes) => call('modify_action', { id: handleId(h), ...changes }),
        delay: (h, time) => call('delay_action', { id: handleId(h), dueAt: typeof time === 'string' ? time : new Date(typeof time === 'number' ? time : Date.now() + time.afterMs).toISOString() }),
      };
      const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
      const result = await new AsyncFunction('ctx', 'actions', 'tools', 'input', item.code)(item.context, actions, tools, item.input);
      if (pending.size) throw Error('Unawaited calls');
      emit({ kind: 'done', ok: true, result: result ?? null });
      process.exit(0);
    } catch { emit({ kind: 'done', ok: false, error: { code: 'CODE_ERROR', message: 'Bun code failed; sandbox changes discarded.' } }); process.exit(1); }
  })();
});
