import { spawn } from "node:child_process";
import { startGui } from "../src/gui-server.mjs";
import { createBrain } from "../src/brain.mjs";

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
  const brain = createBrain({ brain: { provider: "stub" }, automation: { mode: "alert-only" } });
  const decision = await brain.decide(
    {
      chat: "Smoke Chat",
      latest: { author: "Someone", time: "now", text: "urgent: please call" },
      history: [{ author: "Someone", time: "now", text: "urgent: please call" }],
      userProfile: "alarm on direct requests",
      whitelisted: false,
      config: { automation: { mode: "alert-only" } },
    },
    {
      onInput: (x) => seen.push(["input", x]),
      onOutput: (x) => seen.push(["output", x]),
      onDecision: (x) => seen.push(["decision", x]),
    }
  );
  if (decision.action !== "alarm") throw new Error("stub trace decision did not alarm");
  if (!seen.some(([kind, x]) => kind === "input" && x.provider === "stub")) {
    throw new Error("brain trace input callback missing");
  }
  if (!seen.some(([kind, x]) => kind === "decision" && x.decision?.action === "alarm")) {
    throw new Error("brain trace decision callback missing");
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

  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const page = await pageResponse.text();
  for (const marker of ['id="pipeline"', 'id="diagnosticsEvents"', "Message pipeline"]) {
    if (!page.includes(marker)) throw new Error(`observability UI marker missing: ${marker}`);
  }
  for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    // Compile browser scripts without executing them; catches malformed injected JS.
    new Function(match[1]);
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

  console.log("Bun child_process + brain trace + observability UI + GUI WebSocket smoke tests passed.");
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
