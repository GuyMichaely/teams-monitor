import { once } from "node:events";
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
  if (!server.listening) await once(server, "listening");

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/alerts?access_token=runtime-smoke-token`);
  await Promise.race([
    once(ws, "open"),
    once(ws, "error").then(([event]) => {
      throw new Error(`WebSocket smoke test failed: ${event?.message || "connection error"}`);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket smoke test timed out")), 5000)),
  ]);

  console.log("GUI WebSocket smoke test passed.");
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    const closed = once(ws, "close");
    ws.close();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
  await close();
}
