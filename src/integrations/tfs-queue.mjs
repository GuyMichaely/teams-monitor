// Dispatcher-side job queue for TFS Agent Protocol v2 (pull model).
// The brain enqueues a job and awaits its result; a polling worker (on the VM) takes
// the job and posts the result back. Transport-agnostic — the HTTP layer lives in
// tfs-server.mjs. In-memory, single-process.

import { randomUUID } from "node:crypto";

export function createQueue({ resultTimeoutMs = 120000 } = {}) {
  const pending = []; // jobs not yet taken by a worker: { id, method, params }
  const waiters = []; // parked long-polls: { resolve, timer }
  const inflight = new Map(); // id -> { resolve, reject, timer } (awaiting a result)

  /** Brain calls this. Returns a promise that resolves with the worker's result. */
  function enqueue(method, params = {}) {
    const id = randomUUID();
    const job = { id, method, params };

    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        const e = new Error(`worker did not return a result for ${method} within ${resultTimeoutMs}ms`);
        e.code = "worker_timeout";
        reject(e);
      }, resultTimeoutMs);
      inflight.set(id, { resolve, reject, timer });
    });

    // Hand to a parked worker if one is waiting, else queue it.
    const w = waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(job);
    } else {
      pending.push(job);
    }
    return resultPromise;
  }

  /** Worker long-poll. Resolves with a job, or null after waitMs (-> 204). */
  function takeNext(waitMs = 25000) {
    const job = pending.shift();
    if (job) return Promise.resolve(job);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, waitMs);
      waiters.push(entry);
    });
  }

  /** Worker posts a result. payload = { ok, result } | { ok:false, error }. */
  function submitResult(id, payload) {
    const entry = inflight.get(id);
    if (!entry) return { ack: false, error: { code: "unknown_job" } };
    clearTimeout(entry.timer);
    inflight.delete(id);
    if (payload?.ok) {
      entry.resolve(payload.result);
    } else {
      const err = payload?.error || { code: "tfs_error", message: "worker reported failure" };
      const e = new Error(err.message || "worker reported failure");
      e.code = err.code || "tfs_error";
      entry.reject(e);
    }
    return { ack: true };
  }

  function stats() {
    return { pending: pending.length, inflight: inflight.size, waiters: waiters.length };
  }

  return { enqueue, takeNext, submitResult, stats };
}
