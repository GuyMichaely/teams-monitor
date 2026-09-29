import "./smoke-env.mjs";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { normalizeStatus, setPresenceOnSession, getTeamsPresence, setTeamsPresence } from "../src/teams-presence.mjs";

const profile = "me-control-avatar-trigger", menu = "set-presence-status-menu-item";
const prefix = "me_control_presence_availability_";
const labels = { available: "available", busy: "busy", do_not_disturb: "do not disturb", be_right_back: "be right back", appear_away: "away", appear_offline: "offline" };
function fixture({ missing = null, update = true, menuOpen = false, initial = "available", beforeEval = async () => {} } = {}) {
  const state = { profileOpen: menuOpen, submenu: false, raw: initial, clicks: [], composer: "unsent draft" };
  const document = { querySelector(selector) {
    const tid = selector.match(/data-tid="([^"]+)"/)?.[1];
    if (tid === missing) return null;
    if (![profile, menu, "me-control-avatar-presence", ...Object.keys(labels).map(k => prefix + k)].includes(tid)) throw Error("Unexpected selector: " + selector);
    return {
      getClientRects: () => (tid === menu ? state.profileOpen : tid.startsWith(prefix) ? state.profileOpen && state.submenu : true) ? [{}] : [],
      getAttribute: name => name === "aria-label" ? state.raw : name === "aria-expanded" ? String(state.profileOpen) : null,
      click() {
        state.clicks.push(tid);
        if (tid === profile) { state.profileOpen = !state.profileOpen; state.submenu = false; }
        else if (tid === menu) state.submenu = !state.submenu;
        else if (update) state.raw = labels[tid.slice(prefix.length)];
      },
    };
  } };
  const session = { async send(method, params) {
    assert.equal(method, "Runtime.evaluate", "Never dispatch keyboard/text input");
    await beforeEval(params.expression);
    return { result: { value: runInNewContext(params.expression, { document }) } };
  } };
  return { state, session };
}

for (const [requested, expected] of [["Available", "available"], ["busy", "busy"], ["Do not disturb", "dnd"], ["Be right back", "brb"], ["Appear away", "away"], ["Appear offline", "offline"]]) {
  const { state, session } = fixture();
  assert.equal(normalizeStatus(requested), expected);
  const result = await setPresenceOnSession(session, requested);
  assert.equal(result.value, expected); assert.equal(result.verified, true);
  assert.equal(state.composer, "unsent draft"); assert.equal(state.profileOpen, false);
}
{
  const { state, session } = fixture({ menuOpen: true });
  await setPresenceOnSession(session, "busy");
  assert.equal(state.profileOpen, true, "Do not close a profile menu the user opened");
}
{
  const { state, session } = fixture();
  await assert.rejects(setPresenceOnSession(session, "nonsense"), { httpCode: 400 });
  assert.equal(state.clicks.length, 0);
}
{
  const { state, session } = fixture({ missing: prefix + "busy" });
  await assert.rejects(setPresenceOnSession(session, "busy"), /did not appear/);
  assert.equal(state.profileOpen, false);
}
{
  const { state, session } = fixture({ update: false });
  await assert.rejects(setPresenceOnSession(session, "busy"), { httpCode: 502 });
  assert.equal(state.profileOpen, false);
}

// Real transport checks, with an isolated CDP server; never connect to the user's Teams.
let mode = "live";
let pauseVerification = false;
let badgeReads = 0;
let verificationEntered;
let releaseVerification;
const verificationGate = new Promise(resolve => { releaseVerification = resolve; });
const mock = fixture({ beforeEval: async expression => {
  if (expression.includes("me-control-avatar-presence")) badgeReads++;
  if (pauseVerification && badgeReads >= 2 && expression.includes("me-control-avatar-presence")) {
    pauseVerification = false;
    verificationEntered();
    await verificationGate;
  }
} });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/devtools/")) return server.upgrade(req, { data: url.pathname }) ? undefined : new Response(null, { status: 400 });
    const target = (id) => ({ type: "page", url: "https://teams.microsoft.com/v2/", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/${id}` });
    return Response.json(mode === "offline" ? [] : [target("stalled"), target("live"), ...(mode === "ambiguous" ? [target("other")] : [])]);
  }, websocket: { async message(ws, data) {
    if (ws.data === "/devtools/stalled") return;
    const message = JSON.parse(data);
    const result = await mock.session.send(message.method, message.params);
    ws.send(JSON.stringify({ id: message.id, result }));
  } },
});
try {
  assert.equal((await getTeamsPresence(server.port)).value, "available", "Skip stalled background targets");
  const enteredVerification = new Promise(resolve => { verificationEntered = resolve; });
  badgeReads = 0;
  pauseVerification = true;
  const first = setTeamsPresence("busy", server.port);
  await enteredVerification;
  const middle = setTeamsPresence("away", server.port);
  const latest = setTeamsPresence("dnd", server.port);
  assert.equal((await middle).superseded, true, "Drop queued selections superseded before execution");
  releaseVerification();
  assert.equal((await first).superseded, true, "An in-flight selection becomes stale during read-back");
  const latestResult = await latest;
  assert.equal(latestResult.value, "dnd");
  assert.equal(latestResult.verified, true);
  assert.deepEqual(mock.state.clicks.filter(x => x.startsWith(prefix)), [prefix + "busy", prefix + "do_not_disturb"], "Serialized UI work skips stale pending selections");
  const recovered = await setTeamsPresence("away", server.port);
  assert.equal(recovered.value, "away", "A failed prior operation must not wedge the queue");
  mode = "offline";
  assert.equal((await getTeamsPresence(server.port)).connected, false);
  await assert.rejects(setTeamsPresence("busy", server.port), { httpCode: 503 });
  mode = "ambiguous";
  await assert.rejects(setTeamsPresence("busy", server.port), { httpCode: 409 });
} finally { server.stop(true); }
console.log("Teams presence: menu controls, verification, cleanup, validation, concurrency and bounded CDP discovery passed.");
