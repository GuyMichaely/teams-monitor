const PRESENCE_HTML = `
  <h2>Teams availability</h2>
  <div class="card">
    <div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div class="row">
        <span id="teamsPresenceDot" class="dot" style="background:var(--dim)"></span>
        <strong id="teamsPresenceText">checking...</strong>
      </div>
      <div class="row">
        <select id="teamsPresenceSelect"
          style="background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="dnd">Do not disturb</option>
          <option value="brb">Be right back</option>
          <option value="away">Appear away</option>
          <option value="offline">Appear offline</option>
        </select>
        <button id="btnTeamsPresence" class="secondary" onclick="setTeamsPresenceFromGui()">Set</button>
      </div>
    </div>
    <p style="color:var(--dim);font-size:12px;margin:10px 0 0">
      Uses Teams' built-in status commands through the existing local CDP connection.
    </p>
  </div>
`;

const PRESENCE_SCRIPT = `<script>
function renderTeamsPresence(p) {
  const dot = document.getElementById("teamsPresenceDot");
  const text = document.getElementById("teamsPresenceText");
  const select = document.getElementById("teamsPresenceSelect");
  if (!dot || !text) return;
  if (!p.connected) {
    dot.style.background = "var(--bad)";
    text.textContent = "Teams CDP unavailable";
    return;
  }
  dot.style.background = p.value === "available" ? "var(--ok)" : "var(--accent)";
  text.textContent = p.status || p.raw || "status unavailable";
  if (select && p.value && document.activeElement !== select) select.value = p.value;
}
async function refreshTeamsPresence() {
  try { renderTeamsPresence(await tunnelApi("/api/teams/presence")); }
  catch { /* transient */ }
}
async function setTeamsPresenceFromGui() {
  const select = document.getElementById("teamsPresenceSelect");
  const button = document.getElementById("btnTeamsPresence");
  if (!select || !button) return;
  button.disabled = true;
  try {
    const result = await tunnelApi("/api/teams/presence", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: select.value }),
    });
    renderTeamsPresence(result);
    if (typeof toast === "function") {
      toast(result.verified ? "Teams status updated" : "Status command sent; verification pending");
    }
  } catch (e) {
    if (typeof toast === "function") toast(e.message);
  } finally {
    button.disabled = false;
  }
  setTimeout(refreshTeamsPresence, 1000);
}
refreshTeamsPresence();
setInterval(refreshTeamsPresence, 10000);
</script>`;

export function injectPresenceControls(page) {
  if (page.includes('id="teamsPresenceSelect"')) return page;
  return page
    .replace('  <h2>Overview</h2>', PRESENCE_HTML + '\n  <h2>Overview</h2>')
    .replace('</body>', PRESENCE_SCRIPT + '\n</body>');
}
