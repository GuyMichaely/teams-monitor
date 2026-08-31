// Final dashboard layout pass. Earlier layers own the individual controls and logs;
// this module only groups their rendered sections into control/state and logs panes.

const LAYOUT_STYLE = `
<style id="dashboardLayoutStyle">
  main { width:100%; max-width:none; margin:0; padding:14px 18px 24px; }
  .dashboard-title { margin-bottom:10px; }
  .dashboard-split { display:grid; grid-template-columns:clamp(480px,36vw,620px) minmax(0,1fr); gap:18px; align-items:start; }
  .dashboard-pane { min-width:0; }
  .dashboard-pane-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin:0 0 8px; padding-bottom:8px; border-bottom:1px solid var(--line); }
  .dashboard-pane-head h2 { margin:0; }
  .dashboard-pane-note { color:var(--dim); font-size:11px; }
  .dashboard-section { min-width:0; }
  .dashboard-section > h2 { margin-top:16px; }
  .dashboard-section:first-of-type > h2 { margin-top:10px; }
  .dashboard-left .grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dashboard-left #profile { min-height:260px; }
  .brain-file-note { color:var(--dim); font-size:12px; margin:0 0 8px; }
  .brain-file-note code { color:var(--fg); }
  .dashboard-left #diagnosticsSummary { margin:0; }
  .dashboard-left .diag-summary { display:grid; grid-template-columns:1fr; gap:6px; }
  .dashboard-left .diag-pill { white-space:normal; line-height:1.35; }
  .system-health-card { display:flex; flex-direction:column; gap:9px; }
  .system-health-headline { display:flex; align-items:center; gap:8px; font-weight:650; }
  .system-health-headline .dot { flex:0 0 auto; }
  .dashboard-right #pipeline { max-height:none; }
  .dashboard-right .diag-events { max-height:420px; }
  .dashboard-right #diagnosticsLog { max-height:420px; }
  .dashboard-right #log { max-height:420px; }
  @media (min-width:1051px) {
    body { overflow:hidden; }
    main { height:100vh; overflow:hidden; }
    .dashboard-split { height:calc(100vh - 62px); overflow:hidden; align-items:stretch; }
    .dashboard-pane { height:100%; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding-right:8px; }
    .dashboard-pane-head { position:sticky; top:0; z-index:4; background:var(--bg); padding-top:2px; }
  }
  @media (max-width:1050px) {
    body { overflow:auto; }
    main { height:auto; overflow:visible; }
    .dashboard-split { grid-template-columns:1fr; height:auto; overflow:visible; }
    .dashboard-pane { height:auto; overflow:visible; padding-right:0; }
    .dashboard-pane-head { position:static; }
    .dashboard-left .grid { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  }
  @media (max-width:560px) {
    main { padding:12px; }
    .dashboard-pane-head { align-items:flex-start; flex-direction:column; }
  }
</style>`;

const LAYOUT_SCRIPT = `<script id="dashboardLayoutScript">
(function() {
  const main = document.querySelector("main");
  if (!main || document.getElementById("dashboardSplit")) return;

  const title = [...main.children].find(function(el) {
    return el.querySelector?.("#statusDot") || el.id === "statusDot";
  });
  if (title) title.classList.add("dashboard-title");

  const split = document.createElement("div");
  split.id = "dashboardSplit";
  split.className = "dashboard-split";

  const left = document.createElement("section");
  left.className = "dashboard-pane dashboard-left";
  left.innerHTML = '<div class="dashboard-pane-head"><h2>Config and system state</h2><span class="dashboard-pane-note">controls, health, recovery state</span></div>';

  const right = document.createElement("section");
  right.className = "dashboard-pane dashboard-right";
  right.innerHTML = '<div class="dashboard-pane-head"><h2>Logs</h2><span class="dashboard-pane-note">message flow and runtime diagnostics</span></div>';

  function sectionForHeading(text) {
    return [...main.querySelectorAll(":scope > h2")].find(function(h) {
      return h.textContent.trim().replace(/\\s+LIVE.*$/i, "") === text;
    });
  }

  function movePair(text, target, rename) {
    const heading = sectionForHeading(text);
    if (!heading) return null;
    const body = heading.nextElementSibling;
    const wrapper = document.createElement("div");
    wrapper.className = "dashboard-section";
    if (rename) heading.childNodes[0].nodeValue = rename;
    wrapper.appendChild(heading);
    if (body) wrapper.appendChild(body);
    target.appendChild(wrapper);
    return wrapper;
  }

  movePair("Runtime", left);
  movePair("Teams availability", left);
  movePair("Overview", left, "Overview");
  movePair("Message policy", left);
  movePair("Auto-send whitelist", left);
  movePair("Brain context (user-profile.md)", left, "Brain context / instructions");
  movePair("Message pipeline", right);

  const diagnostics = movePair("Connection diagnostics", right, "Connection logs");
  if (diagnostics) {
    const summary = diagnostics.querySelector("#diagnosticsSummary");
    if (summary) {
      const health = document.createElement("div");
      health.className = "dashboard-section";
      health.innerHTML = '<h2>System health</h2><div class="card system-health-card"><div class="system-health-headline"><span id="systemHealthDot" class="dot" style="background:var(--dim)"></span><span id="systemHealthText">checking...</span></div></div>';
      health.querySelector(".system-health-card").appendChild(summary);
      const runtime = left.querySelector(".dashboard-section");
      if (runtime?.nextSibling) left.insertBefore(health, runtime.nextSibling);
      else left.appendChild(health);
    }
  }

  movePair("Escalations", right);
  movePair("Alarms", right);
  movePair("Recent activity", right);
  movePair("Orchestrator log", right);

  for (const child of [...main.children]) {
    if (child === title || child === split) continue;
    if (child.tagName === "H2" || child.classList?.contains("card") || child.classList?.contains("feed") || child.tagName === "PRE") {
      right.appendChild(child);
    }
  }

  split.append(left, right);
  if (title) title.insertAdjacentElement("afterend", split);
  else main.prepend(split);

  const profile = document.getElementById("profile");
  if (profile) {
    profile.setAttribute("rows", "18");
    const card = profile.closest(".card");
    if (card && !card.querySelector(".brain-file-note")) {
      const note = document.createElement("div");
      note.className = "brain-file-note";
      note.innerHTML = 'Stored in <code>context/user-profile.md</code>';
      card.insertBefore(note, profile);
    }
  }

  function updateHealthHeadline() {
    const dot = document.getElementById("systemHealthDot");
    const text = document.getElementById("systemHealthText");
    const summary = document.getElementById("diagnosticsSummary");
    if (!dot || !text || !summary) return;
    const pills = [...summary.querySelectorAll(".diag-pill")];
    const delivery = pills.find(function(p) { return p.textContent.startsWith("Delivery:"); });
    const bad = pills.filter(function(p) { return p.classList.contains("bad"); });
    if (bad.length) {
      dot.style.background = "var(--bad)";
      text.textContent = delivery?.textContent || bad[0].textContent || "degraded";
    } else if (delivery?.classList.contains("ok")) {
      dot.style.background = "var(--ok)";
      text.textContent = delivery.textContent;
    } else {
      dot.style.background = "var(--warn)";
      text.textContent = delivery?.textContent || "state incomplete";
    }
  }

  const summary = document.getElementById("diagnosticsSummary");
  if (summary && typeof MutationObserver !== "undefined") {
    new MutationObserver(updateHealthHeadline).observe(summary, { childList:true, subtree:true, attributes:true, characterData:true });
  }
  updateHealthHeadline();
})();
</script>`;

export function injectDashboardLayout(page) {
  if (page.includes('id="dashboardLayoutStyle"')) return page;
  return page
    .replace("</head>", LAYOUT_STYLE + "\n</head>")
    .replace("</body>", LAYOUT_SCRIPT + "\n</body>");
}
