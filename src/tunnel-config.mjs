// This repo is a single-user deployment with one already-provisioned named tunnel.
// Keep its identity in one place so GUI control and health monitoring cannot drift.

export const TUNNEL_NAME = "teams-gui";
export const TUNNEL_HOST = "gui.guymichaely.com";
export const PUBLIC_TUNNEL_URL = `https://${TUNNEL_HOST}/`;

export function publicHealthUrl(config) {
  const worker = config?.controlWorker || {};
  // Older gitignored config.json files predate this option. Missing means use the
  // known deployment URL; an explicitly present empty string still disables probing.
  if (Object.prototype.hasOwnProperty.call(worker, "publicHealthUrl")) {
    return String(worker.publicHealthUrl || "").trim();
  }
  return PUBLIC_TUNNEL_URL;
}
