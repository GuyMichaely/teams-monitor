# Optional Cloudflare control Worker

This Worker is optional. FCM and WebSocket delivery continue to work without it.

It provides:

- PC/orchestrator heartbeat expiry through a Durable Object alarm;
- mirrored PC/phone recovery state;
- a rendezvous path when the home tunnel/direct control path is unavailable;
- high-priority FCM recovery/control pushes when the Worker has a usable phone FID.

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
    "authTokenEnv": "GUI_TOKEN",
    "heartbeatIntervalMs": 60000,
    "heartbeatTimeoutMs": 180000
  }
}
```

After the phone next reaches the PC directly, `/api/control/sync` gives it the Worker URL. The phone then keeps that URL locally for fallback control/safety synchronization.

## Endpoints

- `GET /health` — unauthenticated deployment health check.
- `POST /api/pc/sync` — PC heartbeat + mirrored control state.
- `POST /api/pc/event` — immediate recovery event; may trigger a high-priority FCM control push.
- `POST /api/phone/sync` — phone FID/control state + returns the latest PC state.

The POST endpoints require `Authorization: Bearer <CONTROL_TOKEN>`.
