# Project TODO

Last reviewed 2026-08-31 against `main`.

This file tracks work that is still relevant to the current system. It is not a history of old implementation plans.

## Current alert-only system

The core Teams-to-phone path is implemented. Remaining work is mostly live validation on the real PC and phone.

- Validate Teams CDP monitoring against the currently installed Teams desktop client.
- Validate Gemini decisions using real Teams traffic.
- Validate Android FID registration end to end.
- Validate real FCM alert delivery, including Android background/Doze behavior.
- Validate real WebSocket delivery through the Cloudflare Tunnel.
- Force FCM failures and verify WebSocket fallback behavior.
- Recover FCM and verify one successful current-generation FCM send restores FCM and releases temporary WebSocket demand.
- Force WebSocket/tunnel failures and verify FCM remains usable.
- Test invalid/stale FID recovery and generation isolation.
- Test phone reboot behavior. There is intentionally no boot receiver, so WebSocket cannot be assumed available after reboot until the app has been opened again.

## Watchdog behavior

Implemented with the optional Cloudflare Worker:

- PC sends fresh orchestrator heartbeat state to the Worker.
- Worker independently detects heartbeat loss after its configured timeout.
- Worker sends a high-priority FCM health message to the phone.
- Failed Worker health pushes are retried.
- The phone's roughly 15-minute control sync provides a slower backup path for learning persisted Worker incidents.
- Tunnel health and PC/orchestrator heartbeat are separate incidents.

Still to decide/implement:

- When the Worker is disabled and the phone's periodic direct-PC control sync fails, decide whether the phone should raise a local health incident. A failed request may mean the PC/tunnel is down or merely that the phone has poor connectivity, so the incident should probably be phrased as the PC control path being unreachable rather than asserting that the PC is dead.
- Deploy and live-test the Worker only if the independent watchdog path is wanted in production.

## Alert durability

Deferred for now.

`alert_phone` currently attempts the preferred transport and then the alternate transport. If both fail, the alert payload is not retained for later delivery.

Later reliability work should consider:

- a persisted outbound alert queue keyed by `alertId`;
- retrying the same `alertId` after transient transport recovery;
- optionally adding phone receipt acknowledgements if confirmed device receipt becomes a requirement.

Android already deduplicates by `alertId`, so retrying the same alert later can be made safe without causing duplicate alarms.

## Future automation features

These are product ideas, not blockers for the current alert-only system.

### Response policy

If automatic Teams replies are enabled again, replace the old binary whitelist model with a more useful risk policy. Likely requirements:

- low-risk messages may be answered automatically;
- benign messages may be ignored;
- uncertain or risky messages should alert the user rather than guess;
- follow-ups should take earlier decisions into account;
- deterministic gates should remain for hard constraints, with the LLM handling the gray area.

The current `alert-only` mode prevents Teams sends regardless of whitelist state.

### Org hierarchy awareness

Potential future context for the brain:

- relevant managers, peers, and reports;
- automatically refreshed rather than hand-maintained;
- supplied to the model as structured context.

### GUI context and instructions

Potential additions:

- editable current-focus/context supplied to the brain;
- editable standing monitoring/reply instructions;
- per-person or per-chat notes if they prove useful.

The current GUI already exposes the monitoring/decision/action pipeline and connection diagnostics, so the old TODO describing it as primarily a log viewer is obsolete.

## Separate TFS integration

`tfs-agent/` is a separate experimental integration for executing TFS operations from an outbound-only VM. It is not part of Teams monitoring or phone-alert delivery and is not required for the current system.

No TFS work is currently treated as a blocker here. If that integration is no longer wanted, it can be removed separately rather than mixed into the alert-system backlog.
