import { DurableObject } from "cloudflare:workers";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
let oauthCache = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authorized(request, env) {
  const expected = String(env.CONTROL_TOKEN || "");
  if (!expected) return false;
  return request.headers.get("Authorization") === `Bearer ${expected}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (!authorized(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
    if (request.method !== "POST") return json({ ok: false, error: "not found" }, 404);
    if (!["/api/pc/sync", "/api/phone/sync", "/api/pc/event"].includes(url.pathname)) {
      return json({ ok: false, error: "not found" }, 404);
    }

    const id = env.CONTROL.idFromName("default");
    const stub = env.CONTROL.get(id);
    return await stub.fetch(request);
  },
};

export class ControlState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: "invalid JSON" }, 400); }

    if (url.pathname === "/api/pc/sync") return await this.pcSync(body);
    if (url.pathname === "/api/phone/sync") return await this.phoneSync(body);
    if (url.pathname === "/api/pc/event") return await this.pcEvent(body);
    return json({ ok: false, error: "not found" }, 404);
  }

  async pcSync(body) {
    const state = (await this.ctx.storage.get("state")) || {};
    const wasMissing = state.incidents?.heartbeat?.status === "missing";
    state.pc = {
      at: body.at || new Date().toISOString(),
      orchestratorHeartbeatAt: body.orchestratorHeartbeatAt || null,
      heartbeatTimeoutMs: clamp(Number(body.heartbeatTimeoutMs) || 180000, 30000, 3600000),
      state: body.state || {},
    };
    state.updatedAt = new Date().toISOString();

    if (wasMissing) {
      state.incidents ||= {};
      state.incidents.heartbeat = {
        status: "recovered",
        at: state.updatedAt,
      };
      await this.sendPhoneData(state, {
        kind: "health",
        incident: "pc_heartbeat",
        status: "recovered",
        at: state.incidents.heartbeat.at,
      });
    }

    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + state.pc.heartbeatTimeoutMs);
    return json({ ok: true, ...state });
  }

  async phoneSync(body) {
    const state = (await this.ctx.storage.get("state")) || {};
    const incomingFid = typeof body.fid === "string" ? body.fid.trim() : "";
    const incomingAt = Date.parse(body.registrationUpdatedAt || 0);
    const storedAt = Date.parse(state.phone?.registrationUpdatedAt || 0);
    const canReplaceFid = !!incomingFid && (
      !state.phone?.fid ||
      state.phone.fid === incomingFid ||
      (Number.isFinite(incomingAt) && (!Number.isFinite(storedAt) || incomingAt >= storedAt))
    );

    state.phone = {
      ...(state.phone || {}),
      at: body.at || new Date().toISOString(),
      websocketState: body.websocketState || state.phone?.websocketState || null,
      ...(canReplaceFid ? {
        fid: incomingFid,
        registrationUpdatedAt: body.registrationUpdatedAt || state.phone?.registrationUpdatedAt || new Date().toISOString(),
      } : {}),
    };
    state.updatedAt = new Date().toISOString();
    await this.ctx.storage.put("state", state);
    return json({ ok: true, ...state });
  }

  async pcEvent(body) {
    const state = (await this.ctx.storage.get("state")) || {};
    // Only /api/pc/sync is a watchdog heartbeat. Recovery/activity events may
    // update mirrored PC state but must never extend heartbeat liveness.
    state.pc = {
      ...(state.pc || {}),
      state: body.state || state.pc?.state || {},
    };
    state.lastEvent = {
      ...(body.event || {}),
      at: body.at || new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    await this.ctx.storage.put("state", state);

    const actions = Array.isArray(body.event?.actions)
      ? body.event.actions.map(String).filter(Boolean)
      : [];
    if (actions.length) {
      const push = await this.sendPhoneData(state, {
        kind: "control",
        actions: actions.join(","),
        reason: String(body.event?.type || "recovery"),
      });
      state.lastControlPush = {
        at: new Date().toISOString(),
        ok: push.ok,
        error: push.error || null,
      };
      await this.ctx.storage.put("state", state);
    }

    return json({ ok: true, ...state });
  }

  async alarm() {
    const state = (await this.ctx.storage.get("state")) || {};
    const pcAt = Date.parse(state.pc?.at || 0);
    const timeoutMs = clamp(Number(state.pc?.heartbeatTimeoutMs) || 180000, 30000, 3600000);
    const ageMs = Date.now() - pcAt;

    if (Number.isFinite(pcAt) && ageMs < timeoutMs) {
      await this.ctx.storage.setAlarm(pcAt + timeoutMs);
      return;
    }

    if (state.incidents?.heartbeat?.status !== "missing") {
      state.incidents ||= {};
      state.incidents.heartbeat = {
        status: "missing",
        at: new Date().toISOString(),
      };
      const push = await this.sendPhoneData(state, {
        kind: "health",
        incident: "pc_heartbeat",
        status: "missing",
        at: state.incidents.heartbeat.at,
      });
      state.lastHealthPush = {
        at: new Date().toISOString(),
        ok: push.ok,
        error: push.error || null,
      };
      state.updatedAt = new Date().toISOString();
      await this.ctx.storage.put("state", state);
    }
  }

  async sendPhoneData(state, data) {
    const fid = String(state.phone?.fid || "").trim();
    if (!fid) return { ok: false, error: "phone FID missing" };
    try {
      const messageId = await sendFcm(this.env, fid, data);
      return { ok: true, messageId };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
}

async function sendFcm(env, fid, data) {
  const projectId = String(env.FIREBASE_PROJECT_ID || "").trim();
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID missing");
  const accessToken = await firebaseAccessToken(env);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      message: {
        fid,
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")])),
        android: { priority: "HIGH" },
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`FCM ${r.status} ${j.error?.status || ""} ${j.error?.message || ""}`.trim());
  }
  return j.name || null;
}

async function firebaseAccessToken(env) {
  if (oauthCache && Date.now() < oauthCache.expiresAt - 60000) return oauthCache.token;
  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!clientEmail || !privateKey) throw new Error("Firebase service-account secrets missing");

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = "https://oauth2.googleapis.com/token";
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlJson({
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;

  const r = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OAuth ${r.status} ${j.error_description || j.error || ""}`.trim());
  oauthCache = {
    token: j.access_token,
    expiresAt: Date.now() + Number(j.expires_in || 3600) * 1000,
  };
  return oauthCache.token;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
