// Action registry + escalation.
//
// Two things live here:
//  1. escalate() — console escalation (audit log + terminal). The phone
//     counterpart is the alert_phone action below (transport in alerts.mjs).
//  2. A registry of ACTIONS the brain may invoke beyond replying. Anything
//     registered here runs when the brain asks for it — register only what you
//     actually mean to allow.

import { logActivity } from "./state.mjs";
import { sendAlert } from "./alerts.mjs";
import { loadConfig } from "./context.mjs";

// ---- Escalation -----------------------------------------------------------

export async function escalate(payload) {
  await logActivity({ kind: "escalation", payload });
  console.log(`\n🔔 ESCALATION [${payload.chat}] — ${payload.reason}`);
  console.log(`   last: ${payload.latest?.author}: ${payload.latest?.text}\n`);
}

// ---- Action registry ------------------------------------------------------

// Each action: { name, description, sideEffect, run(args, ctx) }.
const REGISTRY = new Map();

export function registerAction(action) {
  REGISTRY.set(action.name, action);
}

export function listActions() {
  return [...REGISTRY.values()].map(({ name, description, sideEffect }) => ({
    name,
    description,
    sideEffect: !!sideEffect,
  }));
}

/** Run the actions the brain asked for. Unknown names are reported, not run. */
export async function runActions(invokeActions, ctx) {
  const results = [];
  for (const a of invokeActions || []) {
    const action = REGISTRY.get(a.name);
    if (!action) {
      results.push({ name: a.name, error: "unknown action" });
      continue;
    }
    try {
      results.push({ name: a.name, result: await action.run(a.args || {}, ctx) });
    } catch (e) {
      results.push({ name: a.name, error: e.message });
    }
  }
  return results;
}

// ---- built-in actions -------------------------------------------------------

registerAction({
  name: "alert_phone",
  description:
    "Push an alert to the user's phone (companion app). Transport per config.alerts.transport: " +
    "'websocket' via the GUI server's /ws/alerts hub, or 'fcm' direct via Firebase Cloud Messaging.",
  sideEffect: true,
  run: async (args) => {
    const config = await loadConfig();
    return await sendAlert(args, config);
  },
});
