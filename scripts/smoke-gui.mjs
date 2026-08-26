import { spawn } from "node:child_process";
import { startGui } from "../src/gui-server.mjs";

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

await testChildProcess();

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

  console.log("Bun child_process + GUI WebSocket smoke tests passed.");
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
