# Alert Transport Reliability Architecture

> **Status:** Design proposal for review. This document describes the intended architecture and state machines; it is **not** a statement that these changes have been implemented yet.
>
> The existing application already supports FCM and WebSocket alert transports. The design below turns them into a coordinated, self-recovering delivery system and adds an **optional** Cloudflare Worker/Durable Object control plane.

## 1. Goals

The alert system should:

1. Deliver alarms quickly when the preferred transport is healthy.
2. Fall back to the other transport when delivery is uncertain or failing.
3. Recover the preferred transport automatically when possible.
4. Avoid duplicate alarms when the same alert is attempted over multiple transports.
5. Distinguish permanent transport failures from transient failures.
6. Keep normal operation direct between the PC and phone whenever possible.
7. Allow an optional Cloudflare Worker to improve recovery and diagnosis without becoming a dependency for otherwise-working direct communication.
8. Detect broader infrastructure problems such as a dead orchestrator/PC or broken tunnel when the optional Worker is enabled.
9. Give the Android app configurable local behavior for infrastructure-health incidents.
10. Keep operational/control data separate from Teams message contents, Gemini prompts, and other sensitive application data.

## 2. Non-goals

The optional Worker is **not** intended to:

- carry normal Teams alert payloads;
- proxy normal FCM sends from the orchestrator;
- replace the home GUI server;
- replace the Cloudflare Tunnel used by the WebSocket/GUI path;
- store Teams messages, Gemini prompts, user-profile text, or normal application logs;
- become mandatory for FCM or WebSocket delivery.

If the Worker is configured and then becomes unavailable, a system whose direct paths still work should continue to function essentially like a Worker-disabled installation.

---

# 3. Components

## PC side

### Orchestrator

The orchestrator decides whether an incoming Teams message requires an alarm and asks the alert-delivery layer to deliver it.

The orchestrator should not contain transport-specific failover logic throughout its message-processing code. It should hand an alert to an alert/delivery manager.

### Alert/Delivery Manager

Responsible for:

- FCM sends;
- WebSocket sends;
- per-alert retry/fallback;
- classifying transport errors;
- assigning alert IDs;
- tracking end-to-end acknowledgements;
- maintaining transport health state;
- initiating recovery when a transport is degraded.

### GUI / local alert hub

The GUI server remains the local HTTP/WebSocket hub. The Cloudflare Tunnel exposes it remotely to the Android app.

### Recovery/Control Manager

Responsible for operational communication between PC, phone, and optionally the Worker:

- current FCM target/FID state;
- FCM health;
- WebSocket health;
- recovery requests;
- FCM probes and acknowledgement state;
- tunnel health;
- state mirroring to/from the optional Worker.

## Phone side

### FCM receiver

Receives normal alerts, probes, and selected control/health messages through Google FCM.

### WebSocket service

Maintains the alternate real-time delivery connection when WebSocket is the active/recovery transport. It already reconnects with exponential backoff; the new design will coordinate that behavior with FCM health.

### Registration manager

Owns the phone's current Firebase registration identity (the planned architecture assumes migration to Firebase's current FID-based registration model).

Responsibilities:

- persist the current registration locally;
- detect a genuinely changed registration/FID;
- send it directly to the PC when possible;
- mirror it to the Worker when configured;
- persist unacknowledged registration updates;
- retry failed synchronization with WorkManager/backoff.

### Recovery manager

Maintains the phone-side transport/recovery state and decides when to opportunistically start or stop the WebSocket fallback.

### Health/watchdog policy

Applies the user's chosen local behavior when the phone learns about an infrastructure-health incident such as PC-heartbeat loss.

Example policies may include:

- alarm immediately;
- show a notification but do not alarm;
- do nothing;
- alarm after a configurable delay;
- alarm at a configured time if the incident is still unresolved.

## Optional Cloudflare control plane

When enabled, use a Cloudflare Worker plus a stateful component (preferably a Durable Object rather than KV for the canonical live state).

Its roles are:

- shadow/mirror important operational state;
- provide a rendezvous point when PC and phone cannot talk directly;
- receive PC heartbeats;
- independently observe the public tunnel endpoint;
- maintain active infrastructure incidents;
- optionally send FCM health/watchdog events when the PC is unavailable;
- allow the phone's periodic safety poll to discover state it did not receive through a direct channel.

It is **not the primary control path** when PC and phone can communicate directly.

---

# 4. Core architectural rule: direct first, Worker second

When the Worker is enabled, normal control communication should still be direct wherever practical.

```text
PRIMARY
PC <========================> Phone
     HTTP / WebSocket / FCM

SECONDARY / SHADOW
PC --------> Worker <-------- Phone
```

There are two categories of Worker traffic.

## 4.1 Direct-first control data

For information that naturally belongs between the phone and PC:

1. try the direct path first;
2. mirror the resulting state to the Worker when configured;
3. if the direct path fails, use the Worker as the fallback rendezvous.

Examples:

- new FID/registration;
- FCM degraded/recovered state;
- recovery requests;
- preferred/recovery transport state;
- FCM probe state;
- operational acknowledgements.

Example: phone gets a new FID.

```text
Phone obtains FID B
        |
        +---- POST directly to PC
        |        |
        |        +-- success -> fastest possible repair
        |        |
        |        +-- failure -------------------+
        |                                       |
        +---- mirror FID B to Worker <----------+
```

Even after a successful direct update, the Worker receives an auxiliary copy so that it is not stale when it is later needed for failover.

## 4.2 Independently observed Worker data

Some data only has value if it goes to the Worker directly and independently.

Examples:

- PC heartbeat -> Worker;
- Worker -> external probe of `gui.guymichaely.com`;
- phone heartbeat/state summary -> Worker if phone-presence monitoring is enabled.

Routing a PC heartbeat through the phone would defeat the purpose of having an independent observer.

---

# 5. Delivery plane

The Worker does not participate in normal alert delivery.

```text
                    preferred
PC / orchestrator -------------> FCM -------------> Phone
        |
        |
        +----------------------> WebSocket --------> Phone
                                 alternate
```

The design treats FCM and WebSocket as two delivery capabilities rather than mutually exclusive application modes.

At any moment one may be the **preferred** transport, but the other may still be attempted for a specific alert or used temporarily during recovery.

## Normal desired state

```text
FCM:       healthy + preferred
WebSocket: off unless otherwise needed
Worker:    optional shadow/watchdog only
```

FCM remains the preferred normal transport because Android/Google maintains the underlying push infrastructure efficiently and it avoids keeping an application-specific foreground WebSocket service running continuously.

---

# 6. Two different failover decisions

A key design requirement is to separate **delivering this alert** from **changing the system's preferred transport**.

## 6.1 Per-alert fallback

Question:

> How long should an urgent alert wait before we try the alternate delivery path?

This should be aggressive.

Example policy:

```text
send alert by preferred FCM
        |
        +-- success/ACK -> done
        |
        +-- transient failure
                |
                +-- one short retry
                |
                +-- attempt WebSocket for this alert
```

Trying WebSocket for this one alert does **not** automatically mean FCM has been declared globally unhealthy.

## 6.2 Transport degradation threshold

Question:

> How much evidence should be required before we change the preferred/recovery transport state?

This should be less aggressive and configurable.

Example, not yet a final default:

```json
{
  "failover": {
    "alertRetryCount": 1,
    "degradeAfterFailures": 3,
    "failureWindowSeconds": 120,
    "recoverAfterSuccesses": 2
  }
}
```

This avoids flapping because of a single random 503, timeout, or short network interruption.

## Permanent errors bypass transient thresholds

A definitive invalid-target/unregistered FCM result is not a transient failure.

```text
FCM says target is permanently invalid
        |
        +-- stop using that target immediately
        +-- mark FCM registration unhealthy
        +-- begin registration recovery
```

There is no value in retrying a known-dead FID/target N times just because the transient threshold is N.

---

# 7. Alert identity, acknowledgement, and deduplication

Failover introduces ambiguity. A request may time out even though the phone actually received it.

Therefore every alert should receive a stable `alertId` before the first delivery attempt.

Example:

```text
FCM alertId=123 -> result uncertain
WebSocket alertId=123 -> delivered
```

The phone keeps a bounded recent-ID cache and handles alert `123` only once.

## End-to-end acknowledgement

Transport-level success is not enough.

For example, a successful POST into the WebSocket hub only proves that the hub accepted/broadcast the event, not necessarily that Android processed the alarm.

The phone should explicitly ACK an alert after it has accepted/processed the alert event.

Conceptually:

```text
PC -- alert 123 --> phone
PC <-- ACK 123 ---- phone
```

ACK may travel over whichever control path is currently available.

The PC can then distinguish:

- accepted by upstream transport;
- delivered to a WebSocket connection;
- explicitly processed by the Android app.

---

# 8. FCM registration/FID lifecycle

The planned implementation should migrate new recovery machinery to Firebase's current FID-oriented registration model rather than expanding the old token-specific design.

The exact raw-HTTP FID targeting behavior should be validated against the current Firebase production API/SDK during implementation. This is an implementation validation item, not an architectural dependency.

The important architectural fact is:

> The phone is the source of truth for its current Firebase registration identity. The PC cannot create a replacement registration on the phone's behalf.

## Registration data is not the Firebase credential

Keep these concepts separate:

- **FID / device registration target**: changes as the app installation's Firebase registration changes; supplied by the phone.
- **Firebase service-account credential/private key**: stable server credential used to authenticate sends; secret; not regenerated when the phone's FID changes.

If the optional Worker is allowed to send watchdog FCM messages itself, the Worker will need the Firebase service credential stored as a Worker secret. The FID itself is operational targeting state, not the service-account credential.

---

# 9. State machine: phone notices registration change first

This is generally the cleanest path.

```text
                 +--------------------+
                 | FCM normal / FID A |
                 +----------+---------+
                            |
                   Firebase reports B
                            |
                            v
                 +--------------------+
                 | registration       |
                 | transition         |
                 | local FID = B      |
                 +----------+---------+
                            |
              +-------------+-------------+
              |                           |
              v                           v
      send B directly to PC       mirror B to Worker
              |                    (if enabled)
              |
        +-----+-----+
        |           |
     success      failure
        |           |
        |           +--> persist pending sync
        |                + WorkManager retry
        |
        v
   PC knows B
        |
        v
   send silent FCM probe to B
        |
        v
   phone receives probe
        |
        v
   phone ACKs probe
        |
        v
 +---------------------+
 | FCM proven healthy  |
 | temporary WS can    |
 | be stopped          |
 +---------------------+
```

## WebSocket during this transition

A genuinely changed FID creates a window in which the phone may know FID B while the PC still has A.

The phone should therefore enter a **registration transition/recovery-wanted** state immediately.

It may opportunistically start the WebSocket fallback if Android allows that foreground-service start in the app's current execution state.

The design must **not depend** on the WebSocket being startable from a background registration callback. Modern Android can restrict starting foreground services from the background.

The required recovery path is therefore:

1. persist B locally;
2. immediately attempt the short HTTPS synchronization;
3. enqueue durable retry work if synchronization is not acknowledged;
4. opportunistically start WebSocket if permitted;
5. stay in transition until an end-to-end FCM probe is acknowledged.

---

# 10. State machine: PC notices invalid FCM target first

Example: the PC attempts an FCM send to registration A and FCM definitively rejects it as invalid/unregistered.

```text
             +----------------+
             | FCM healthy / A|
             +--------+-------+
                      |
              FCM rejects A
                      |
                      v
             +----------------+
             | FCM invalid    |
             | A is unusable  |
             +--------+-------+
                      |
          +-----------+------------+
          |                        |
          v                        v
mirror incident to Worker   tell phone directly
(if enabled)                if any direct path exists
                                  |
                      +-----------+-----------+
                      |                       |
                   succeeds                unavailable
                      |                       |
                      |               phone eventually
                      |               sees Worker state
                      |               on safety poll
                      +-----------+-----------+
                                  |
                                  v
                       phone obtains/confirms
                       current registration B
                                  |
                                  v
                       direct POST B to PC
                       + mirror to Worker
                                  |
                                  v
                          PC sends FCM probe
                                  |
                                  v
                           phone ACKs probe
                                  |
                                  v
                         FCM healthy again
                         temporary WS stops
```

If the Worker is disabled and neither FCM nor the tunnel/direct path works, PC and phone cannot coordinate until one of those paths recovers. This is an intentional limitation of Worker-disabled mode.

---

# 11. FCM recovery probe

Do not declare FCM restored merely because the PC has received a new registration/FID or because Google's send API accepts a request.

Use a silent probe with a unique probe ID.

Example conceptual FCM payload:

```json
{
  "kind": "probe",
  "probeId": "..."
}
```

The phone does **not** alarm for a probe. It ACKs the probe over any available control path.

```text
new registration B reaches PC
        |
        v
send FCM probe(B)
        |
        v
phone receives probe
        |
        v
ACK probe
        |
        v
FCM = healthy
        |
        v
stop temporary WebSocket
```

A configurable number of successful probes/sends may be required before returning from degraded state to normal if we want hysteresis.

---

# 12. WebSocket state machine

The existing Android WebSocket service already reconnects with exponential backoff. The new system should put that behavior inside the broader transport state.

```text
            +------------------+
            | WS not required  |
            +--------+---------+
                     |
           recovery/fallback needed
                     |
                     v
            +------------------+
            | starting WS      |
            +--------+---------+
                     |
             +-------+-------+
             |               |
          connected        failure
             |               |
             v               v
       +-----------+    reconnect/backoff
       | WS usable |          |
       +-----+-----+          +-----> starting WS
             |
       FCM proven healthy
       and WS no longer needed
             |
             v
      +---------------+
      | stop WS       |
      +---------------+
```

A WebSocket failure does not automatically imply that FCM is unhealthy. Likewise an FCM failure does not imply the tunnel is unhealthy.

Those health dimensions must be tracked separately.

---

# 13. Direct control communication

Possible direct paths include:

- phone -> PC HTTPS through `gui.guymichaely.com`;
- PC -> phone WebSocket control message when WS is connected;
- PC -> phone FCM control message while FCM works;
- phone -> PC WebSocket ACK/control message if bidirectional control messages are added/used;
- phone -> PC HTTPS ACK/control endpoint.

Use the fastest currently-working direct route before relying on Worker polling.

The Worker is the fallback rendezvous, not an excuse to add poll latency to a working direct channel.

---

# 14. Optional Worker behavior

## Worker disabled

```text
FCM delivery:        PC -> Google -> Phone
WebSocket delivery:  PC -> GUI/tunnel -> Phone
Control:             PC <-> Phone directly
Registration sync:   Phone -> tunnel -> PC
Safety poll:         Phone -> home control endpoint
```

If the tunnel is unavailable:

- FCM can continue normally;
- WebSocket is unavailable;
- direct phone -> PC control is unavailable;
- pending registration updates are retained/retried;
- if both FCM and tunnel are unavailable, automatic cross-device coordination waits for one to recover.

## Worker enabled

Normal direct communication stays the same, but important operational state is mirrored.

```text
                         +-----------------------+
                         | Worker / Durable      |
                         | Object shadow state   |
                         +-----------+-----------+
                                     ^
                                    / \
                                   /   \
                                  /     \
                                 /       \
                                /         \
                               /           \
                              /             \
                             /               \
                           PC <=============> Phone
                                direct first
```

When a direct control operation fails, either side may consult/publish through the Worker.

### Required invariant

> Enabling the Worker may improve resilience. Losing the Worker must not break FCM or WebSocket paths that would have worked in Worker-disabled mode.

If the Worker becomes unavailable:

- normal FCM continues;
- normal WebSocket continues;
- direct registration sync through the tunnel continues;
- only Worker-specific watchdog/rendezvous capabilities are lost.

When the Worker returns, PC and phone republish their current authoritative state and reconcile using generation/version numbers.

---

# 15. Versioned mirrored state

Because the same state may travel through multiple paths, stale messages must not overwrite newer state.

Example registration sequence:

```text
FID A generation 12
FID B generation 13
FID C generation 14
```

If the Worker receives C and then a delayed B, it must retain C.

Each authoritative source should attach a monotonically increasing generation/version where practical.

Example:

```json
{
  "fid": "...",
  "generation": 14
}
```

The PC and Worker should reject an older generation after a newer one is known.

Health/incidents should likewise use stable incident IDs and/or state versions so duplicated/mirrored messages are idempotent.

---

# 16. Suggested Worker/Durable Object state

Keep this intentionally small.

Example conceptual state:

```json
{
  "pc": {
    "lastHeartbeat": "...",
    "fcmStatus": "healthy",
    "tunnelStatus": "healthy",
    "preferredTransport": "fcm",
    "stateVersion": 104
  },
  "phone": {
    "lastSeen": "...",
    "fid": "...",
    "fidGeneration": 17,
    "websocketStatus": "disconnected",
    "stateVersion": 61
  },
  "incidents": []
}
```

Do not mirror sensitive application content merely because the Worker exists.

### Worker secrets

If Worker watchdogs are allowed to send FCM directly when the PC is unavailable, store the Firebase service-account secret material using Cloudflare Worker secrets, not inside normal Durable Object state.

---

# 17. PC heartbeat watchdog

This is a Worker-only reliability capability because an independent observer must exist outside the PC.

Normal behavior:

```text
PC ---- heartbeat ----> Worker / Durable Object
```

The heartbeat means something like:

> The PC-side watchdog/orchestrator process is alive and currently has outbound Internet connectivity to Cloudflare.

It does **not** by itself prove that the public tunnel works.

## Durable Object alarm model

Rather than continuously polling whether the PC died:

```text
heartbeat arrives
      |
      v
record lastHeartbeat
      |
      v
schedule/reset expiry alarm
```

If another heartbeat arrives, reset the expiry.

If the expiry alarm actually fires:

```text
no heartbeat within allowed window
        |
        v
open PC-unreachable incident
        |
        v
optionally send health incident by FCM
        |
        v
phone applies local configured policy
```

When heartbeats resume, the Worker resolves the same incident and sends/records a recovery event so a delayed phone alarm can be cancelled.

---

# 18. Tunnel health is separate from PC heartbeat

This distinction is critical.

The following state is possible:

```text
PC:            alive
orchestrator:  alive
PC Internet:   working
FCM:           working
cloudflared:   broken
public tunnel: broken
```

PC heartbeats to the Worker will continue normally, so heartbeat success cannot be used as tunnel health.

## Worker-enabled external tunnel probe

The Worker independently probes a small public health endpoint through the real hostname.

```text
Worker ---- GET ----> https://gui.guymichaely.com/health
```

This allows canonical state such as:

```text
PC alive:       YES
Tunnel healthy: NO
FCM healthy:    YES
```

That is substantially more informative than a failed phone request alone.

## Worker-disabled tunnel detection

The PC may also periodically test its own public URL. If it detects:

```text
Tunnel unhealthy
FCM healthy
```

it can immediately send the phone a control/status message through FCM.

This does not provide the same independent observation as the Worker, but it remains useful.

---

# 19. Phone safety polling

Even with event-driven direct messages and a Worker capable of sending FCM, keep a slow independent phone poll as a safety net.

Target when Worker enabled:

```text
phone -> Worker control state
```

Target when Worker disabled:

```text
phone -> home GUI/control endpoint
```

Suggested healthy-state cadence: approximately 15 minutes using Android's battery-friendly periodic work. This is a suggested default/tunable, not a strict timing SLA.

The poll exists to discover circular failures such as:

```text
Worker knows FCM is broken
        |
Worker tries to notify phone by FCM
        |
FCM is the broken component
        |
phone never receives notification
        |
periodic phone poll discovers active incident
```

When the system is already in recovery, retries/checks may be considerably more aggressive (for example immediate, 1 minute, 2 minutes, 5 minutes, 10 minutes, then back toward the normal interval).

---

# 20. Infrastructure-health incidents and phone policy

Health events should be explicit operational events, separate from Teams alerts.

Example:

```json
{
  "kind": "health_incident",
  "incidentId": "...",
  "component": "pc",
  "status": "unreachable",
  "since": "..."
}
```

Recovery:

```json
{
  "kind": "health_recovered",
  "incidentId": "..."
}
```

The phone owns the detailed user policy for what happens on receipt.

Possible policy:

```text
PC heartbeat lost:
[ ] alarm immediately
[ ] notification only
[ ] do nothing
[ ] alarm if still broken after N minutes
[ ] alarm at configured time if still broken
```

A recovery event cancels any not-yet-fired delayed alarm for that incident.

## High-priority FCM caution

High-priority FCM should be reserved for genuinely time-sensitive/user-visible events. The Worker should not indiscriminately send every silent status transition at high priority.

If the Worker itself decides whether an incident needs urgent FCM delivery, mirror only the minimal policy needed for that decision (for example `watchdogDelivery: urgent|normal`) rather than copying all detailed local phone preferences into the Worker.

---

# 21. Failure classification

## FCM

### Permanent target/registration failure

Examples conceptually include an invalid/unregistered target.

Response:

- no transient retry budget;
- mark current target unusable;
- open recovery state;
- directly inform phone if a path exists;
- mirror to Worker if enabled;
- obtain current phone registration;
- probe and ACK before declaring recovery.

### Transient FCM failure

Examples conceptually include temporary network/server/rate conditions.

Response:

- retry with backoff as appropriate;
- apply a small per-alert retry allowance;
- use alternate delivery for the current alert when necessary;
- only mark FCM degraded after configurable repeated evidence.

## WebSocket

### Single disconnect

- existing reconnect/backoff behavior;
- FCM remains available for alerts;
- do not globally declare tunnel broken based solely on one socket disconnect.

### Persistent connection failure

- configurable degradation threshold;
- prefer FCM while WebSocket recovery continues;
- use direct/Worker health information to distinguish phone network, tunnel, or server issues where possible.

## Worker

### Worker unreachable

- do not interrupt otherwise-working FCM;
- do not interrupt otherwise-working WebSocket/direct control;
- continue direct behavior;
- retry Worker synchronization later;
- republish current authoritative state when it returns.

---

# 22. Important failure scenarios

## Scenario A: FCM target changes, phone notices first

```text
Phone receives new FID B
-> persist B
-> direct sync to PC
-> mirror to Worker if enabled
-> retry persistently if either required sync fails
-> opportunistically start WS if recovery wants it and Android permits
-> PC probes FCM B
-> phone ACKs
-> FCM healthy
-> stop temporary WS
```

Expected result: usually little or no interruption.

## Scenario B: PC discovers old FCM target is invalid first

```text
PC gets permanent FCM target error
-> mark FCM invalid immediately
-> tell phone directly if possible
-> mirror incident to Worker
-> phone gets/confirms current FID
-> direct sync to PC + mirror Worker
-> FCM probe/ACK
-> recover
```

If direct paths are unavailable and Worker is enabled, the Worker is the rendezvous.

## Scenario C: FCM transient error during a real alert

```text
FCM send fails transiently
-> limited fast retry
-> alternate WebSocket attempt for same alertId
-> dedupe on phone
-> do not necessarily mark FCM globally degraded
```

Repeated failures within the configured window may move FCM into degraded state.

## Scenario D: tunnel breaks, PC/Internet/FCM remain healthy

Worker enabled:

```text
PC heartbeat continues
Worker's tunnel probe fails
-> state = PC healthy, tunnel unhealthy
-> Worker and/or PC can inform phone over FCM
-> WebSocket unavailable
-> FCM continues normally
```

Worker disabled:

```text
PC may self-test public tunnel endpoint
-> detects failure
-> informs phone over FCM if desired
```

## Scenario E: PC/orchestrator disappears

Worker enabled:

```text
heartbeats stop
-> Durable Object expiry alarm fires
-> open PC-unreachable incident
-> Worker sends FCM health event if configured
-> phone applies local policy
-> later heartbeat resolves incident
```

Worker disabled:

The phone can only infer a problem by its direct home-endpoint checks. It cannot reliably distinguish PC-off, home Internet, GUI, orchestrator, or tunnel failure.

## Scenario F: FCM broken and tunnel broken

Worker enabled:

```text
PC <-> Worker still possible
Phone <-> Worker still possible
-> Worker coordinates current registration/recovery
-> WebSocket remains unavailable
-> FCM may be repaired independently of tunnel
```

Worker disabled:

There is no cross-device coordination path until either FCM or the tunnel recovers.

## Scenario G: Worker fails

```text
FCM healthy -> alerts continue
WS healthy  -> alerts continue
Direct PC/phone control -> continues
Worker watchdog/rendezvous -> temporarily unavailable
```

This is intentional graceful degradation.

---

# 23. State ownership

| State | PC | Phone | Worker when enabled |
|---|---|---|---|
| Current FID/registration | cached consumer | **authoritative source** | mirrored copy |
| Registration generation | cached | **authoritative source** | mirrored copy |
| Firebase service credential | **secret/source for normal sends** | no | secret only if Worker sends watchdog FCM |
| FCM transport health | **primary evaluator for sends** | observed/recovery view | mirrored canonical coordination state |
| WebSocket client connection | server view | **client view** | optional summary |
| Pending registration upload | no | **authoritative local retry state** | acknowledgement/copy |
| Preferred transport config | PC/config source | synchronized view | mirrored |
| Alert IDs/ACK state | yes | bounded dedupe/ACK state | normally unnecessary |
| PC heartbeat | sender | observer | **independent source of truth** |
| Tunnel health | can self-probe | observes | independent external probe |
| Detailed watchdog action prefs | no | **authoritative** | no; only minimal urgency policy if needed |
| Teams/Gemini content | local application data | only alert payload when delivered | **never mirrored** |

---

# 24. Proposed control/transport states

These names are illustrative and may change during implementation.

## FCM states

- `healthy`
- `suspect`
- `degraded`
- `invalid_registration`
- `registration_transition`
- `probing`

## WebSocket states

- `off`
- `starting`
- `connected`
- `reconnecting`
- `degraded`

## Overall recovery states

- `normal_fcm`
- `temporary_dual_path`
- `websocket_recovery`
- `fcm_registration_recovery`
- `control_plane_degraded`

Avoid encoding all information into one giant enum if independent dimensions are clearer. In particular, FCM health, WebSocket health, tunnel health, Worker health, and PC heartbeat health are separate facts.

---

# 25. Suggested configuration surface

Exact values are for review; architecture should support them.

Example:

```json
{
  "alerts": {
    "preferredTransport": "fcm",
    "failover": {
      "alertRetryCount": 1,
      "degradeAfterFailures": 3,
      "failureWindowSeconds": 120,
      "recoverAfterSuccesses": 2
    }
  },
  "controlPlane": {
    "worker": {
      "enabled": false,
      "url": ""
    },
    "phoneSafetyPollMinutes": 15
  },
  "watchdog": {
    "pcHeartbeatEnabled": true,
    "pcHeartbeatIntervalSeconds": 60,
    "pcHeartbeatTimeoutSeconds": 180,
    "tunnelProbeEnabled": true
  }
}
```

Worker-specific settings should be ignored cleanly when Worker support is disabled.

The phone should expose its health-incident action policy separately from server transport configuration.

---

# 26. Observability requirements

The existing GUI pipeline should eventually make transport behavior understandable without reading raw logs.

For each alert, display at least:

- `alertId`;
- preferred transport;
- each delivery attempt;
- retry/fallback decision;
- transport error classification;
- WebSocket/FCM result;
- Android end-to-end ACK;
- final delivery status.

For recovery/control state, expose:

- current FCM health;
- current FID generation (not necessarily the full identifier in casual UI);
- WebSocket state;
- tunnel state;
- Worker configured/reachable state;
- PC heartbeat age;
- active incidents;
- most recent FCM probe/ACK;
- reason for current preferred/recovery transport.

Sensitive credentials must never appear in diagnostics.

---

# 27. Security and privacy boundaries

1. Keep Firebase service-account private material secret on the PC and, only if required for Worker watchdog sends, in Cloudflare Worker secrets.
2. Do not put service credentials in Durable Object/KV application state.
3. Authenticate PC <-> phone direct control endpoints.
4. Authenticate PC/phone <-> Worker operations independently from public health reads, if any.
5. Do not treat a FID as a general authentication credential.
6. Do not mirror Teams messages, Gemini prompts, user profile, or normal activity logs into Cloudflare merely for reliability.
7. Use idempotent/versioned updates so replayed stale control messages cannot roll state backward.
8. Redact FIDs and identifiers in normal UI/log output where full values are not needed.

---

# 28. Design invariants

These are stronger than suggested defaults and should survive implementation details.

1. **FCM is the preferred normal delivery transport.**
2. **WebSocket is the alternate/recovery delivery transport, not a permanently required parallel connection.**
3. **A real alert may fall back faster than the global preferred transport changes.**
4. **Permanent transport errors bypass transient-failure thresholds.**
5. **Every alert has an ID and is deduplicated across transports.**
6. **End-to-end phone ACK is stronger evidence than transport-level acceptance.**
7. **FCM is not declared recovered until a phone-received probe/ACK proves the path.**
8. **The phone is authoritative for its current Firebase registration identity.**
9. **Failed phone registration synchronization is persisted and retried.**
10. **Direct PC <-> phone communication is preferred whenever it works.**
11. **When enabled, the Worker mirrors enough state to take over coordination when direct communication fails.**
12. **The Worker never becomes necessary for a direct operation that could otherwise succeed.**
13. **PC heartbeat and tunnel health are separate signals.**
14. **Worker failure must not break otherwise-working FCM or WebSocket delivery.**
15. **The phone retains a slow independent poll as a last-resort way to discover control-plane state.**
16. **Operational state is versioned/idempotent where redundant paths can reorder updates.**
17. **The Worker stores operational state only, not application-content history.**

---

# 29. Open decisions before implementation

The architecture is intentionally explicit about the following items that still need a final value or validation.

## Tunable policy decisions

- Per-alert transient retry count/delay before alternate delivery.
- Number/window of transient failures before a transport becomes degraded.
- Number of successful probes/sends required before recovery.
- Healthy-state phone safety-poll interval (approximately 15 minutes is the current preferred default).
- PC heartbeat interval and expiration timeout.
- Tunnel probe interval.
- How long to retain phone-side alert IDs for deduplication.
- Whether WebSocket should be attempted on every genuine FID change or only when registration propagation/probing shows delay; current design allows opportunistic startup during the transition.
- Exact phone actions/preferences for health incidents.
- Which health events warrant high-priority versus normal-priority FCM.

## Implementation validations

- Validate Firebase's current FID registration APIs on Android and migrate from the existing token-specific callbacks cleanly.
- Validate the exact supported raw HTTP-v1 FID targeting payload against the current Firebase production backend; if necessary, use the current Firebase Admin SDK rather than relying on undocumented wire behavior.
- Verify the best Android WorkManager design for durable registration synchronization and recovery retries.
- Verify foreground-service start behavior for opportunistic WebSocket recovery on all supported Android versions; recovery must not depend on a start that Android may prohibit.
- Define authentication and request-signing for the optional Worker.
- Define the Durable Object schema and alarm behavior.

---

# 30. Implementation shape (for later, not yet executed)

A likely code organization would separate concerns roughly as follows:

```text
PC
  AlertManager
    - assign alertId
    - FCM/WebSocket attempt policy
    - retry/fallback
    - ACK tracking

  TransportHealth
    - FCM health/error classification
    - WS health
    - recovery hysteresis

  RecoveryManager
    - FID synchronization state
    - probes
    - direct control messages
    - Worker mirror/fallback

  Watchdog
    - heartbeat
    - local/external tunnel checks

Phone
  RegistrationManager
    - current FID
    - generation
    - persistent sync retry

  TransportManager
    - FCM state
    - WS recovery state

  AlertReceiver
    - alertId dedupe
    - alarm
    - ACK

  RecoveryManager
    - probe handling
    - control state
    - Worker safety polling

  HealthPolicy
    - immediate/delayed/no alarm behavior

Optional Cloudflare
  Worker + Durable Object
    - mirrored state
    - rendezvous
    - heartbeat expiry
    - tunnel observation
    - health incidents
    - optional watchdog FCM
```

The implementation should reuse existing FCM, WebSocket, GUI, diagnostics, and Android logging code rather than replacing working components wholesale.

---

# 31. Summary

The target system has three conceptual layers:

```text
                     DELIVERY

              +----------------+
PC ---------->| FCM (preferred)|----------> Phone
 |            +----------------+
 |
 |            +----------------+
 +----------->| WS (alternate) |----------> Phone
              +----------------+


                  DIRECT CONTROL

PC <======================================> Phone
        HTTP / WS / FCM where applicable


             OPTIONAL SHADOW CONTROL

PC ---------------> Worker <--------------- Phone
        mirror / rendezvous / watchdog
```

Normal operation is simple: **FCM delivers alerts and WebSocket stays off**.

When something fails, the system first uses whatever direct path still works, while the optional Worker keeps a shadow operational view. The Worker only becomes operationally important when direct coordination fails or when an independent observer is needed.

The most important recovery loop is:

```text
FCM problem
   |
   v
alternate communication if available
   +
phone synchronizes current registration
   |
   v
PC sends FCM probe
   |
   v
phone ACKs probe
   |
   v
FCM healthy
   |
   v
stop temporary WebSocket
```

With the Worker disabled, this remains functional as long as a direct coordination path is available. With the Worker enabled, additional combinations such as **FCM failure + tunnel failure** can still be coordinated, and the system gains independent PC/tunnel watchdog capabilities without making Cloudflare part of normal alert delivery.
