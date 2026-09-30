import "./smoke-env.mjs";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startGui } from "../src/gui-server.mjs";
import { createBrain } from "../src/brain.mjs";
import { CONFIG_FILE } from "../src/local-paths.mjs";

const port = 18090;
process.env.GUI_TOKEN = "runtime-smoke-token";

async function testChildProcess() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && stdout.trim()) resolve();
      else reject(new Error(`Bun child_process smoke test failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function testBrainTrace() {
  const seen = [];
  const brain = createBrain({ brain: { provider: "stub" } });
  const decision = await brain.reviewPlan(
    {
      chat: "Smoke Chat",
      latest: { author: "Someone", time: "now", text: "urgent: please call" },
      history: [{ author: "Someone", time: "now", text: "urgent: please call" }],
      userProfile: "alarm on direct requests",
      whitelisted: false,
      config: {},
      rulePlan: { evaluations: [], proposals: [], allowedAdditions: [], replyAllowed: false },
    },
    {
      onInput: (x) => seen.push(["input", x]),
      onOutput: (x) => seen.push(["output", x]),
      onDecision: (x) => seen.push(["decision", x]),
    }
  );
  if (decision.changes.length || decision.additions.length) throw new Error("stub must retain proposals without additions");
  if (!seen.some(([kind, x]) => kind === "input" && x.provider === "stub")) {
    throw new Error("brain trace input callback missing");
  }
  if (!seen.some(([kind, x]) => kind === "output" && x.raw)) {
    throw new Error("brain trace output callback missing");
  }
}

await testChildProcess();
await testBrainTrace();

const { server, close } = startGui({
  gui: {
    host: "127.0.0.1",
    port,
    authTokenEnv: "GUI_TOKEN",
  },
});

let ws;
try {
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }

  for (const method of ["GET", "HEAD"]) {
    const apkResponse = await fetch(`http://127.0.0.1:${port}/app-debug.apk?access_token=must-not-forward`, {
      method,
      redirect: "manual",
    });
    if (apkResponse.status !== 302 || apkResponse.headers.get("location") !==
        "https://github.com/GuyMichaely/teams-monitor/releases/download/android-latest/teams-monitor.apk") {
      throw new Error(`${method} APK download must redirect to the stable GitHub release without credentials`);
    }
    if (apkResponse.headers.get("cache-control") !== "no-store" ||
        apkResponse.headers.get("referrer-policy") !== "no-referrer" || await apkResponse.text() !== "") {
      throw new Error(`${method} APK redirect must be uncached, suppress referrers, and have no body`);
    }
  }

  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const page = await pageResponse.text();
  for (const marker of ['id="pipeline"', 'id="messages"', 'id="pollStatus"', 'id="replyMode"', '<title>TM — Dashboard</title>']) {
    if (!page.includes(marker)) throw new Error(`observability UI marker missing: ${marker}`);
  }
  for (const match of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    // Compile browser scripts without executing them; catches malformed injected JS.
    new Function(match[1]);
  }

  const diagnosticsResponse = await fetch(`http://127.0.0.1:${port}/api/diagnostics?limit=5`, {
    headers: { Authorization: "Bearer runtime-smoke-token" },
  });
  if (!diagnosticsResponse.ok) {
    throw new Error(`diagnostics endpoint failed: ${diagnosticsResponse.status}`);
  }
  const diagnostics = await diagnosticsResponse.json();
  if (!diagnostics.alertDelivery?.delivery?.primaryTransport) {
    throw new Error("diagnostics alert delivery state missing");
  }
  if (!diagnostics.alertDelivery?.fcm || diagnostics.alertDelivery.fcm.backoffMs == null) {
    throw new Error("diagnostics FCM health/backoff state missing");
  }

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/alerts?access_token=runtime-smoke-token`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket smoke test timed out")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket smoke test connection failed"));
    }, { once: true });
  });

  // Changing delivery settings must update a phone already listening on WS.
  // The fake service account exists only in smoke-env's temporary home and is
  // used for validation; this smoke never sends an FCM message.
  const cfg = Bun.YAML.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.alerts.fcm = { serviceAccountFile: "config/smoke-fcm-account.json" };
  await writeFile(CONFIG_FILE, Bun.YAML.stringify(cfg, null, 2) + "\n");
  await writeFile(join(dirname(CONFIG_FILE), "smoke-fcm-account.json"), JSON.stringify({ project_id: "smoke-project" }));
  const control = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("delivery change control message timed out")), 3000);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.kind !== "control" || !message.actions.includes('stop_ws')) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  const saveResponse = await fetch(`http://127.0.0.1:${port}/api/config/alerts`, {
    method: "PUT",
    headers: { Authorization: "Bearer runtime-smoke-token", "Content-Type": "application/json" },
    body: JSON.stringify({ transport: "fcm", fallbackTransport: null }),
  });
  if (!saveResponse.ok) throw new Error(`alert config save failed: ${saveResponse.status}`);
  const controlMessage = await control;
  if (!controlMessage.actions.includes("set_primary_fcm") || !controlMessage.actions.includes("stop_ws")) {
    throw new Error("FCM-only config change did not tell connected phone to stop WebSocket");
  }
  // Deliberately ignore stop_ws while still answering protocol pings. The
  // server must enforce disabled delivery, not depend on phone cooperation.
  const disconnectedBy = Date.now() + 3000;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health/status`, {
      headers: { Authorization: "Bearer runtime-smoke-token" },
    });
    if ((await response.json()).websocketClients === 0) break;
    if (Date.now() > disconnectedBy) throw new Error('Phone remains counted after FCM-only disconnect');
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  console.log("Bun child_process + brain trace + APK redirect + alert diagnostics + observability UI + GUI WebSocket + live delivery-policy control smoke tests passed.");
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.close();
    });
  }
  await close();
}
