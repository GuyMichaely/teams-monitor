# TFS Agent Protocol v2 (pull model)

Contract between the **dispatcher** (runs on the personal machine with the Teams brain;
hosts the HTTP endpoint, published to the internet) and the **worker** (runs on the
locked-down VM with TFS access; makes only **outbound** connections).

The worker cannot be reached inbound, so it **pulls** jobs by long-polling the dispatcher,
executes them against TFS, and posts results back. The dispatcher initiates the work
(the brain decides "update ticket 123") but never connects to the VM.

```
  dispatcher (personal machine)                worker (VM, outbound-only)
  hosts HTTP, holds job queue      ── job ──▶  long-polls GET /jobs/next
  brain enqueues + awaits result   ◀─ result ─ executes on TFS, POST /jobs/{id}/result
```

If you are implementing the **worker**: a reference worker (`tfs-agent/src/worker.mjs`)
already wraps `handlers.dispatch()` per this spec — use, adapt, or replace it.

## Transport & auth

- HTTP/1.1, JSON, UTF-8. Publish the dispatcher over the internet (tunnel or port-forward).
- Every request carries `Authorization: Bearer <SHARED_TOKEN>` (worker → dispatcher).
  Separate secret from the TFS PAT. Use a long random token; compare constant-time.
- Missing/invalid token → `401`.

## Endpoints (served by the dispatcher)

### `GET /health`
```json
200 { "ok": true, "protocolVersion": "2", "role": "dispatcher", "pending": 0, "inflight": 0 }
```

### `GET /jobs/next?wait=25`
Long-poll for the next job. The dispatcher holds the request open up to `wait` seconds
(default 25, cap 30).

- A job is available:
  ```json
  200 { "id": "uuid", "method": "change_state", "params": { "id": 123, "state": "Resolved" } }
  ```
- No job before timeout:
  ```
  204 No Content
  ```
  The worker should immediately poll again.

### `POST /jobs/{id}/result`
Return the outcome of job `{id}`.

Request body — success:
```json
{ "ok": true, "result": <any JSON> }
```
Request body — failure:
```json
{ "ok": false, "error": { "code": "tfs_error", "message": "..." } }
```
Response:
```json
200 { "ack": true }
```
If `{id}` is unknown or already timed out: `200 { "ack": false, "error": { "code": "unknown_job" } }`
(the worker should just drop it).

## Worker loop (reference behavior)

```
loop forever:
  GET /jobs/next?wait=25
    204 -> continue
    200 -> job:
      try   result = dispatch(method, params)   -> POST result {ok:true, result}
      catch e                                    -> POST result {ok:false, error:{code, message}}
```

## Semantics / rules

- **`id`** is dispatcher-generated; the worker echoes it in the result path.
- **Delivery is at-most-once (v1).** A job is handed to exactly one polling worker. If the
  worker dies after taking a job, the dispatcher's awaiting call rejects on
  `resultTimeoutMs` (`worker_timeout`); there is **no automatic redelivery** yet.
- **Writes are not idempotent** — the worker must not retry a write on its own; the brain
  decides whether to re-enqueue.
- **Multiple workers** are allowed (each poll returns a distinct job); results route by `id`.
- **Binary** is base64 inside `params`/`result`. Recommend a 25 MB body cap → `400`.
- **Error codes** in results: `tfs_error`, `unknown_method`, `write_disabled`, `internal`.
- **Methods & params** are unchanged from the primitive set in `tfs-agent/src/handlers.mjs`
  (see the table in the git history / `contract()`); only the framing moved to pull.
- **Versioning:** `protocolVersion` is `"2"`; `/health` advertises it.

## What changed from v1

v1 had the VM host `POST /rpc` and the laptop call it. Because the real VM is
outbound-only, v2 flips it: the laptop hosts, the VM pulls. Same methods, same auth idea,
same JSON shapes — different who-listens.
