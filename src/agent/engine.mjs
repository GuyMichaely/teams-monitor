import { createServer } from 'node:net';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../local-paths.mjs';
import { loadConfig, loadUserProfile } from '../context.mjs';
import { loadState, saveState, logActivity, markFirstRead } from '../state.mjs';
import { createPoll } from '../poll-status.mjs';
import { replyPolicy } from '../reply-policy.mjs';
import { teamsClient } from '../teams-client.mjs';
import { createScheduleStore, runScheduledAction } from '../scheduled-actions.mjs';
import { agentStore } from './store.mjs';
import { intake, messageContext } from './intake.mjs';
import { executeAction } from './executor.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Socket ownership is live, not inferred from an old PID/heartbeat file.
export async function executorLease(port) {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return () => new Promise(resolve => server.close(resolve));
}

export async function scan({ store, client, config, activatedAt, state, cursor = 0, audit = logActivity }) {
  const poll = createPoll(config.pollIntervalMs || 15000);
  await poll.update();
  let failure;
  try {
    const echo = !!config.debug?.echoLoop;
    const targets = [...new Set(echo ? replyPolicy(config).entries : await client.unread())];
    const observed = Object.keys(state.chats || {}).filter(chat => state.chats[chat]?.reactionSnapshot?.activationId === activatedAt && !targets.includes(chat));
    if (!echo && observed.length) targets.push(observed[cursor % observed.length]);
    await poll.update({ targets: targets.length, status: 'processing', stage: 'Reading chats' });
    state.chats ||= {};
    for (const chat of targets) {
      await poll.update({ currentChat: chat, stage: 'Reading messages' });
      try {
        const { messages } = await client.read(chat);
        const entry = state.chats[chat] ||= {};
        const ids = intake({ store, chat, messages, config, activatedAt, reactions: entry });
        poll.state.examined++;
        poll.state.handled += ids.length;
        for (const id of ids) {
          const row = store.message(id);
          await markFirstRead(state, chat, row.value);
          await audit({ kind: 'flow', flowId: id, flowStartedAt: new Date(row.observed).toISOString(), pollId: poll.state.id, stage: 'message', chat, latest: row.value, historyCount: messages.length });
        }
        if (!ids.length) poll.state.duplicates++;
      } catch { poll.state.errors++; await audit({ kind: 'poll_error', chat, error: 'Chat read failed; no messages queued.' }); }
    }
    await saveState(state);
  } catch (error) { failure = error; throw error; }
  finally { await poll.finish(failure); }
}

export async function runEngine({ handle, onWake, onActionResult, signal, client: injected, store: injectedStore, configLoader = loadConfig, profileLoader = loadUserProfile } = {}) {
  const cfg = await configLoader(), release = await executorLease(cfg.gui?.port === 0 ? 0 : (cfg.gui?.port || 8090) + 2);
  let store, schedules, decisionWork, actionWork;
  const controller = new AbortController();
  const stopFile = join(DATA_DIR, 'STOP'), heartbeat = join(DATA_DIR, 'heartbeat.json');
  const owner = { pid: process.pid, runId: randomUUID() };
  const clearHeartbeat = () => { try { const value = JSON.parse(readFileSync(heartbeat, 'utf8')); if (value.runId === owner.runId) rmSync(heartbeat, { force: true }); } catch {} };
  const stop = () => { controller.abort(); clearHeartbeat(); };
  try {
  let other;
  try { other = JSON.parse(readFileSync(heartbeat, 'utf8')); } catch {}
  if (other?.pid !== process.pid && Date.now() - Date.parse(other?.at) < 120000) {
    let alive = false; try { process.kill(other.pid, 0); alive = true; } catch {}
    if (alive) throw Error('Another executor has a fresh live heartbeat; stop it before cutover.');
  }
  store = injectedStore || agentStore(); schedules = createScheduleStore();
  const activatedAt = new Date().toISOString();
  signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let cursor = 0, nextPoll = 0, config = cfg;
  const stopped = () => controller.signal.aborted || existsSync(stopFile);
  const state = await loadState();
  const client = injected || teamsClient(cfg, owner);
  rmSync(stopFile, { force: true });
  store.recover(activatedAt); schedules.recover(activatedAt);
  const flow = (row, stage, fields = {}) => logActivity({ kind: 'flow', flowId: row.id, flowStartedAt: new Date(row.observed).toISOString(), chat: row.chat, stage, ...fields });
  const decide = async () => {
    const next = store.claimNext(), row = next.kind === 'message' ? next.row : null;
    if (!row) {
      const work = next.row;
      if (!work) return;
      try {
        const context = { ...work.value, trigger: work.kind, now: new Date().toISOString(), userProfile: await profileLoader() };
        const result = await (work.kind === 'action_result' ? onActionResult : onWake)?.(context, { store, configLoader, signal: controller.signal, savedCeiling: context.ceiling });
        if (stopped()) store.finishWork(work.id, 'uncertain');
        else if (result?.ok) store.commit(result.runId || work.id, result, null, work.id);
        else store.finishWork(work.id, result ? 'failed' : 'handled');
      } catch { store.finishWork(work.id, 'failed'); store.record(work.id, 'policy_failed', { error: 'Queued policy work failed.' }); }
      return;
    }
    if (!row.value) { store.finishMessage(row.id, 'invalid'); return; }
    try {
      const context = messageContext(row, store, await configLoader(), await profileLoader());
      context.brief = store.brief(row.chat).text;
      await flow(row, 'policy', { source: 'javascript', reason: 'Running policy' });
      const result = await handle(context, { store, configLoader, signal: controller.signal });
      if (stopped()) { store.finishMessage(row.id, 'uncertain'); return; }
      if (!result.ok) { store.finishMessage(row.id, 'failed'); await flow(row, 'error', { source: 'policy', error: result.error?.message }); return; }
      store.commit(result.runId || randomUUID(), result, row.id);
      await flow(row, 'decision', { action: 'rule_actions', reason: 'Policy completed', ruleActions: result.actions });
      for (const action of result.actions || []) if (!action.cancelled && action.due > Date.now() + 1000) await flow(row, 'effect', {
        effect: { message: 'scheduled_reply', alert: 'scheduled_phone', status: 'scheduled_status', wake: 'scheduled_wake' }[action.kind],
        status: 'ok', actionId: action.id, dueAt: new Date(action.due).toISOString(), reason: 'Saved for later execution' });
      if (!result.actions?.some(a => !a.cancelled)) await flow(row, 'effect', { effect: 'none', status: 'ignored' });
    } catch { store.finishMessage(row.id, 'failed'); await flow(row, 'error', { source: 'policy', error: 'Policy processing failed.' }); }
  };
  const execute = async () => {
    await executeAction({ store, client, loadConfig: configLoader, stopped,
      wake: async action => ({ ok: true, ...store.enqueue('wake', action) }),
      onResult: async (outcome, job) => {
        const row = store.message(job.runId);
        if (row) await flow(row, 'effect', { effect: { message: 'teams_reply', alert: 'phone_alert', status: 'teams_status' }[outcome.action?.kind] || 'agent_wake', status: outcome.state === 'completed' ? 'ok' : 'error', result: outcome.result });
        if (outcome.action?.kind !== 'wake') store.enqueue('action_result', { contextId: `action:${outcome.id}`, outcome });
      } });
    // Existing manual schedules use the very same GUI-owned Teams queue.
    await runScheduledAction({ store: schedules, loadConfig: configLoader, stopped, audit: logActivity,
      sendMessage: async (chat, text, _port, guard, options) => { await guard(); return (await client.send(chat, text, options.expiresAt)).result; },
      setPresence: (status, _cfg, expiry) => client.status(status, expiry) });
  };
    while (!stopped()) {
      if (Date.now() >= nextPoll) {
        try { config = await configLoader(); } catch {}
        // Only a real polling cycle refreshes the heartbeat.
        try { writeFileSync(heartbeat, JSON.stringify({ ...owner, at: new Date().toISOString(), provider: config.brain?.provider }) + '\n'); } catch {}
        try { await scan({ store, client, config, activatedAt, state, cursor: cursor++ }); } catch { store.record(null, 'poll_failed', { error: 'Teams intake unavailable.' }); }
        nextPoll = Date.now() + Math.max(250, Number(config.pollIntervalMs) || 15000);
      }
      if (!decisionWork) decisionWork = decide().catch(() => {}).finally(() => { decisionWork = null; });
      if (!actionWork) actionWork = execute().catch(() => {}).finally(() => { actionWork = null; });
      await sleep(100);
    }
  } finally {
    stop();
    await Promise.allSettled([decisionWork, actionWork]);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); signal?.removeEventListener('abort', stop);
    try { schedules?.close(); if (!injectedStore) store?.close(); }
    finally { clearHeartbeat(); await release(); }
  }
}
