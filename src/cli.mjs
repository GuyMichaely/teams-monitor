#!/usr/bin/env bun
// Command-line entry point for the Teams automation library.
//
//   bun src/cli.mjs read [n]         Read the last n messages (default 15) as JSON.
//   bun src/cli.mjs send "message"   Send a message into the open chat.
//   bun src/cli.mjs watch [ms]       Poll the open chat and print new messages.

import { readMessages, sendMessage, watchMessages } from "./teams.mjs";
import { getAllChats, getUnreadChats, readChat } from "./monitor.mjs";
import { run, hardStop } from "./orchestrator.mjs";
import { loadState } from "./state.mjs";
import { loadConfig } from "./context.mjs";
import { startGui } from "./gui-server.mjs";
import { syncWorkerHeartbeat, workerEnabled } from "./worker-control.mjs";
import { recoverAlertTransport } from "./alerts.mjs";
import { checkPublicTunnel } from "./tunnel-health.mjs";
import { sendPhoneHealth } from "./phone-health.mjs";

const [, , cmd, arg] = process.argv;

async function syncHealthControl(config, { force = false } = {}) {
  const hasWorker = workerEnabled(config);
  await syncWorkerHeartbeat(config, { force }).catch(() => {});

  // With no Worker, the PC still checks its own public tunnel route. This is
  // less independent than the Worker probe but preserves tunnel failure/recovery
  // visibility and can notify the phone over FCM when the public GUI path is down.
  if (!hasWorker) {
    const tunnel = await checkPublicTunnel(config, { force }).catch(() => null);
    if (tunnel?.changed && tunnel.status) {
      await sendPhoneHealth(config, {
        incident: "public_tunnel",
        status: tunnel.status,
        at: tunnel.checkedAt,
      }).catch(() => {});
    }
  }
}

try {
  switch (cmd) {
    case "run": {
      // Health/control work is intentionally outside the Teams polling loop.
      // Worker/tunnel clients rate-limit themselves; FCM recovery has its own cadence.
      let lastAlertRecoveryAt = 0;
      const healthTimer = setInterval(async () => {
        try {
          const config = await loadConfig();
          await syncHealthControl(config);

          const recoveryIntervalMs = Math.max(
            Number(config?.alerts?.failover?.recoveryCheckIntervalMs) || 30_000,
            10_000
          );
          if (Date.now() - lastAlertRecoveryAt >= recoveryIntervalMs) {
            lastAlertRecoveryAt = Date.now();
            await recoverAlertTransport(config).catch(() => {});
          }
        } catch { /* next health tick retries */ }
      }, 10_000);
      healthTimer.unref();
      try {
        const config = await loadConfig();
        await syncHealthControl(config, { force: true });
        await recoverAlertTransport(config).catch(() => {});
        lastAlertRecoveryAt = Date.now();
        await run();
      } finally {
        clearInterval(healthTimer);
      }
      break;
    }
    case "stop": {
      const res = hardStop();
      if (res.killed) {
        console.log(`Orchestrator process ${res.pid} killed.`);
      } else {
        console.log(`No live orchestrator killed (${res.reason}). Stop file left as fallback.`);
      }
      break;
    }
    case "gui": {
      startGui(await loadConfig());
      await new Promise(() => {}); // serve until killed
      break;
    }
    case "catchup": {
      // Show, per chat, the first message Claude handled on your behalf — resume there.
      const state = await loadState();
      const chats = Object.entries(state.chats || {});
      if (!chats.length) {
        console.log("No activity yet.");
        break;
      }
      for (const [name, info] of chats) {
        const f = info.firstReadByClaude;
        console.log(`\n# ${name}`);
        if (f) {
          console.log(`  catch up from: [${f.time || "?"}] ${f.author || "?"}: ${f.text || ""}`);
          console.log(`  (Claude first handled this at ${f.recordedAt})`);
        } else {
          console.log("  (no first-read marker)");
        }
      }
      break;
    }
    case "chats": {
      const chats = await getAllChats();
      console.log(chats.map((c) => c.name).join("\n"));
      break;
    }
    case "unread": {
      const u = await getUnreadChats();
      console.log(u.length ? u.join("\n") : "(none unread)");
      break;
    }
    case "readchat": {
      if (!arg) {
        console.error('Usage: bun src/cli.mjs readchat "Chat Name"');
        process.exit(1);
      }
      const res = await readChat(arg, 20);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "read": {
      const msgs = await readMessages(arg ? Number(arg) : 15);
      console.log(JSON.stringify(msgs, null, 2));
      break;
    }
    case "send": {
      if (!arg) {
        console.error('Usage: bun src/cli.mjs send "your message"');
        process.exit(1);
      }
      const result = await sendMessage(arg);
      console.log(result);
      if (result !== "sent") process.exit(1);
      break;
    }
    case "watch": {
      const intervalMs = arg ? Number(arg) : 3000;
      console.error(`Watching open chat every ${intervalMs}ms. Ctrl+C to stop.`);
      watchMessages(
        (m) => console.log(`[${m.time}] ${m.author}: ${m.text}`),
        { intervalMs }
      );
      // Keep the process alive.
      await new Promise(() => {});
      break;
    }
    default:
      console.error(
        "Usage:\n" +
          "  bun src/cli.mjs run                   start the monitor/respond orchestrator\n" +
          "  bun src/cli.mjs stop                  kill a running orchestrator immediately (break glass)\n" +
          "  bun src/cli.mjs gui                   serve the monitoring dashboard (see config.gui)\n" +
          "  bun src/cli.mjs catchup               show per-chat 'resume reading here' markers\n" +
          "  bun src/cli.mjs chats                 list all chats/channels\n" +
          "  bun src/cli.mjs unread                list chats with unread messages\n" +
          '  bun src/cli.mjs readchat "Name"       open a chat and read it (marks it read)\n' +
          "  bun src/cli.mjs read [n]              read the currently-open chat\n" +
          '  bun src/cli.mjs send "message"        send into the open chat\n' +
          "  bun src/cli.mjs watch [intervalMs]    poll the open chat for new messages"
      );
      process.exit(1);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
