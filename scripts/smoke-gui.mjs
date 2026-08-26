import { startGui } from "../src/gui-server.mjs";

const port = 18090;
process.env.GUI_TOKEN = "runtime-smoke-token";

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

  console.log("GUI WebSocket smoke test passed.");
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
