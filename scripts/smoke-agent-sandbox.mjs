import './smoke-env.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Usage } from '@openai/agents';
import { DATA_DIR, ROOT } from '../src/local-paths.mjs';
import { executeSandbox, sandboxStatus, SANDBOX_DIRECTORY } from '../src/agent/sandbox.mjs';
import { sandboxLimits } from '../src/agent/sandbox-limits.mjs';
import { permissions, permissionCeiling } from '../src/agent/permissions.mjs';
import { agentReview } from '../src/agent/tools.mjs';
import { agentStore } from '../src/agent/store.mjs';
import { blankPlan } from '../src/agent/plan.mjs';

assert.equal(sandboxStatus().available, false);
if (process.platform !== 'win32') { console.log('SKIP native Windows sandbox: unsupported OS; fail-closed status verified.'); process.exit(0); }
await mkdir(SANDBOX_DIRECTORY, { recursive: true });
const build = Bun.spawn(['powershell.exe', '-NoProfile', '-File', join(ROOT, 'scripts', 'build-sandbox.ps1'), '-OutputDirectory', SANDBOX_DIRECTORY], { stdout: 'pipe', stderr: 'pipe' });
const buildOutput = await new Response(build.stdout).text() + await new Response(build.stderr).text();
assert.equal(await build.exited, 0, buildOutput);
assert.equal(sandboxStatus().available, true);
const run = async (code, options = {}) => {
  const result = await executeSandbox({ code, ...options });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
};
const canary = join(DATA_DIR, 'private-canary.txt');
await writeFile(canary, 'private-test-marker');
process.env.TM_SANDBOX_SECRET_FIXTURE = 'not-for-guest';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('should-not-be-reachable') });
try {
  assert.equal(await run('return (await import("node:path")).basename("a/b") + (2+3);'), 'b5');
  const checks = await run(`
    const fs = await import('node:fs/promises');
    const denied = async fn => { try { await fn(); return false; } catch { return true; } };
    return {
      env: process.env.TM_SANDBOX_SECRET_FIXTURE === undefined,
      read: await denied(() => fs.readFile(input.canary)),
      write: await denied(() => fs.writeFile(input.canary, 'changed')),
      scratch: await denied(() => fs.writeFile('scratch.txt', 'changed')),
      profile: await denied(() => fs.writeFile(process.env.LOCALAPPDATA + '/Packages/' + input.moniker + '/AC/x', 'changed')),
    };`, { input: { canary, url: server.url.href, moniker: 'nonexistent' } });
  assert(Object.values(checks).every(Boolean), JSON.stringify(checks));
  for (const code of ['return await fetch(input.url);', 'return await Bun.connect({hostname:"192.0.2.1",port:9,socket:{data(){},error(){}}});']) {
    const network = await executeSandbox({ code, input: { url: server.url.href } });
    assert.equal(network.ok, false, 'Network access must be blocked even if Bun exits during Winsock initialization');
  }
  assert.equal(await readFile(canary, 'utf8'), 'private-test-marker');
  assert.equal(await run('const {dlopen,ptr}=await import("bun:ffi"); const {symbols}=dlopen("userenv.dll",{GetAppContainerRegistryLocation:{args:["u32","ptr"],returns:"i32"}}); return symbols.GetAppContainerRegistryLocation(0x20006,ptr(Buffer.alloc(8)));'), -2147024891, 'Container registry writes must be denied');
  assert.equal(await run('const {dlopen,ptr}=await import("bun:ffi"); const {symbols}=dlopen("advapi32.dll",{SetNamedSecurityInfoW:{args:["ptr","u32","u32","ptr","ptr","ptr","ptr"],returns:"u32"}}); return symbols.SetNamedSecurityInfoW(ptr(Buffer.from(process.cwd()+"/worker.mjs\\0","utf16le")),1,4,null,null,null,null);'), 5, 'Guest cannot relax its own runtime ACLs');
  assert.equal(await run('return await tools.fixture({value: input});', { tools: ['fixture'], input: 7, dispatch: (_, args) => ({ ok: true, value: args.value }) }).then(r => r.value), 7);
  const timeout = await executeSandbox({ code: 'while(true) {}', limits: { timeoutMs: 300 } });
  assert.equal(timeout.error.code, 'TIMEOUT', JSON.stringify(timeout));
  const hungBridge = await executeSandbox({ code: 'return await tools.fixture({});', tools: ['fixture'], dispatch: () => new Promise(() => {}), limits: { timeoutMs: 300 } });
  assert.equal(hungBridge.error.code, 'TIMEOUT', 'Noncooperative bridge must not hang the caller');
  const flood = await executeSandbox({ code: 'while(true) console.log("x".repeat(4096));', limits: { outputBytes: 4096 } });
  assert.equal(flood.error.code, 'OUTPUT_LIMIT', JSON.stringify(flood));
  const memory = await executeSandbox({ code: 'const a=[]; while(true) { const b=Buffer.alloc(16*1024*1024,1); a.push(b); }', limits: { memoryMb: 256, timeoutMs: 3000 } });
  assert.equal(memory.ok, false, 'Allocation must hit the job limit, not host memory');
  const spawned = await run('try { const p=Bun.spawn([process.execPath,"-e","while(true){}"],{stdout:"ignore",stderr:"ignore"}); await Bun.sleep(100); return {pid:p.pid}; } catch(e) { return {denied:e.code === "EPERM" || e.code === "EACCES"}; }');
  if (spawned.pid) assert.throws(() => process.kill(spawned.pid, 0), 'Descendant must die when guest root finishes');
  else assert.equal(spawned.denied, true, 'Blocked child creation is also fail-closed');
  const controller = new AbortController();
  const cancelled = executeSandbox({ code: 'while(true) {}', signal: controller.signal, onActivity: event => { if (event.kind === 'sandbox_started') controller.abort(); } });
  setTimeout(() => controller.abort(), 200);
  assert.equal((await cancelled).error.code, 'CANCELLED');
  assert.equal(sandboxLimits({ memoryMb: 1024 }, { memoryMb: 512 }).memoryMb, 512);
  assert.equal(sandboxLimits({}, { memoryMb: 1024 }).memoryMb, 1024, 'Omitted per-call value uses the global maximum');
  const global = permissionCeiling({ agent: { sandbox: { timeoutMs: 500 } } });
  assert.equal(permissions({ sandbox: { timeoutMs: 1000 } }, global).sandbox.timeoutMs, 500);
  assert.equal(permissions({}, permissionCeiling(), global).sandbox.timeoutMs, 500);

  const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
  const response = output => ({ output, usage: new Usage({ requests: 1 }) });
  const toolResult = request => { const value = request.input.findLast(i => i.type === 'function_call_result').output; return JSON.parse(typeof value === 'string' ? value : value.text); };
  const context = { trigger: 'smoke', chatName: 'Alice', message: { text: 'test', time: new Date().toISOString() } };
  const config = { replyPolicy: { mode: 'whitelist', entries: [] }, agent: { timeoutMs: 30000, maxTurns: 4, maxMessages: 1 } };
  async function reviewCode(code, check, { failModel = false, options = {}, onSecondTurn } = {}) {
    const store = agentStore(':memory:'), plan = blankPlan(); let turn = 0;
    try {
      const result = await agentReview({ prompt: 'fixture', context, source: '', version: 'smoke', plan, store, configLoader: async () => config,
        options: { tools: ['alert', 'write_note'], initiateActions: ['alert'], ...options },
        model: { getResponse: async request => {
          if (++turn === 1) {
            assert(request.tools.some(t => t.name === 'execute_bun'), 'Compute is always available');
            return response([{ type: 'function_call', callId: 'sandbox-1', name: 'execute_bun', arguments: JSON.stringify({ code, inputJson: null }) }]);
          }
          check(toolResult(request)); onSecondTurn?.(store);
          if (failModel) throw Error('fixture provider failure');
          return response([message('complete')]);
        } } });
      return { result, plan };
    } finally { store.close(); }
  }
  let reviewed = await reviewCode('await actions.alert("staged"); await tools.write_note({path:"sandbox.md",text:"test"}); return 7;', r => assert.equal(r.result, 7));
  assert.equal(reviewed.result.ok, true); assert.equal(reviewed.plan.actions.length, 1); assert.equal(reviewed.plan.notes['sandbox.md'], 'test');
  reviewed = await reviewCode('await actions.alert("discarded"); await tools.write_note({path:"discard.md",text:"test"}); throw Error("oops");', r => assert.equal(r.error.code, 'CODE_ERROR'));
  assert.equal(reviewed.result.ok, true); assert.equal(reviewed.plan.actions.length, 0); assert.deepEqual(reviewed.plan.notes, {});
  reviewed = await reviewCode('return await actions.sendMessage("Alice","blocked");', r => assert.equal(r.result.error.code, 'DENIED'));
  assert.equal(reviewed.plan.actions.length, 0);
  reviewed = await reviewCode('return await tools.alert({text:42});', r => assert.equal(r.result.error.code, 'INVALID_TOOL_CALL'));
  reviewed = await reviewCode('await actions.alert("never committed"); return 1;', r => assert.equal(r.ok, true), { failModel: true });
  assert.equal(reviewed.result.ok, false); assert.equal(reviewed.plan.actions.length, 0);
  reviewed = await reviewCode('await actions.alert("never committed"); return 1;', r => assert.equal(r.ok, true), { onSecondTurn: store => store.mode('read_only') });
  assert.equal(reviewed.result.ok, false); assert.equal(reviewed.plan.actions.length, 0);
  reviewed = await reviewCode('return 5;', r => assert.equal(r.result, 5), { options: { tools: [], initiateActions: [] } });
  assert.equal(reviewed.result.ok, true);
  reviewed = await reviewCode('process.stdout.write(JSON.stringify({kind:"call",id:1,name:"set_status",args:{presence:"offline"}})+"\\n"); await Bun.sleep(100); return 5;', r => assert.equal(r.result, 5));
  assert.equal(reviewed.plan.actions.length, 0, 'Forged RPC cannot grant unlisted tools');
  reviewed = await reviewCode('const a=await actions.alert("delayed"); const d=await actions.delay(a,{afterMs:5000}); const m=await actions.modify(a,{text:"modified"}); return {d,m};', r => { assert.equal(r.result.d.ok, true); assert.equal(r.result.m.ok, true); },
    { options: { tools: ['alert', 'schedule', 'modify_action'], initiateActions: ['alert'] } });
  assert.equal(reviewed.plan.actions[0].text, 'modified'); assert(reviewed.plan.actions[0].due > Date.now());
  assert.deepEqual(await readdir(join(SANDBOX_DIRECTORY, 'runs')), [], 'Normal execution cleanup removes private bundles');
  console.log('PASS native Bun execution, file/network/env isolation, limits, descendants, cancellation, scoped bridge, atomic staging and model rollback');
} finally { server.stop(true); delete process.env.TM_SANDBOX_SECRET_FIXTURE; }
