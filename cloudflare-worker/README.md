# Optional Cloudflare control Worker

This Worker is optional. FCM and WebSocket delivery continue to work without it.

It provides:

- PC/orchestrator heartbeat expiry through a Durable Object alarm;
- independent probing of the configured public GUI/tunnel URL;
- mirrored PC/phone recovery state;
- a rendezvous path when the home tunnel/direct control path is unavailable;
- retention of a phone FCM recovery-probe ACK until the PC consumes it;
- high-priority FCM recovery/control/health pushes when the Worker has a usable phone FID.

## Deploy

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Configure these Wrangler secrets:
   - `CONTROL_TOKEN` — use the same value as the PC/phone `GUI_TOKEN`.
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`
3. Deploy with Wrangler.
4. Set the PC's gitignored `config/config.json`:

```json
{
  "controlWorker": {
    "enabled": true,
    "url": "https://<worker-hostname>",
    "publicHealthUrl": "https://gui.guymichaely.com/",
    "authTokenEnv": "GUI_TOKEN",
    "heartbeatIntervalMs": 60000,
    "heartbeatTimeoutMs": 180000
  }
}
```

`publicHealthUrl` should be the public GUI URL reached through the home Cloudflare Tunnel. The Worker probes it from outside the home network, letting it distinguish “PC/orchestrator alive” from “public tunnel unavailable.”

After the phone next reaches the PC directly, `/api/control/sync` gives it the Worker URL. The phone then keeps that URL locally for fallback control/safety synchronization.

## Endpoints

- `GET /health` — unauthenticated Worker deployment health check.
- `POST /api/pc/sync` — PC heartbeat + mirrored control state; consumes a matching retained phone FCM-probe ACK when present.
- `POST /api/pc/event` — immediate recovery event; may trigger a high-priority FCM control push.
- `POST /api/phone/sync` — phone FID/WS state/pending FCM probe ACK + returns the latest mirrored PC/health state.

The POST endpoints require `Authorization: Bearer <CONTROL_TOKEN>`.

## Recovery ACK behavior

When FCM is recovering, Firebase HTTP acceptance alone does not end recovery. The PC sends a silent probe with a unique ID. Android persists that ID after actually receiving the message and mirrors it through `/api/phone/sync`. If direct PC sync is unavailable, the Durable Object retains the ACK. A later `/api/pc/sync` returns the retained ACK to the PC; the PC accepts it only if it matches the currently pending probe and current FID generation, then mirrors `lastAckProbeId` back so Android can clear its local pending ACK.

The Worker never needs Teams message contents for this flow.
