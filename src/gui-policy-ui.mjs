const POLICY_STYLE = `
<style id="messagePolicyStyle">
  .policy-block { border-top:1px solid var(--line); margin-top:12px; padding-top:12px; }
  .policy-title { font-weight:650; margin-bottom:3px; }
  .policy-note { color:var(--dim); font-size:12px; margin:0 0 9px; }
  .policy-rules { display:flex; flex-direction:column; gap:7px; }
  .policy-rule { display:grid; grid-template-columns:95px 110px 95px minmax(130px,1fr) auto; gap:7px; align-items:center; }
  .policy-rule select, .policy-rule input { min-width:0; width:100%; background:#0c0e12; color:var(--fg); border:1px solid var(--line); border-radius:7px; padding:7px 8px; font-size:12px; }
  .policy-rule button { padding:6px 9px; }
  @media (max-width:650px) {
    .policy-rule { grid-template-columns:1fr 1fr; }
    .policy-rule input { grid-column:1 / -1; }
  }
</style>`;

const POLICY_RULES_HTML = `
    <div class="policy-block">
      <div class="policy-title">Deterministic rules</div>
      <p class="policy-note">Alert-only mode: first matching rule wins and bypasses the LLM entirely.</p>
      <div id="policyRules" class="policy-rules"></div>
      <div class="row" style="margin-top:9px">
        <button class="secondary" type="button" onclick="addPolicyRule()">Add rule</button>
        <button id="policyRulesSave" type="button" onclick="savePolicyRules()" disabled>Save rules</button>
      </div>
    </div>`;

const POLICY_SCRIPT = `<script id="messagePolicyScript">
let policyRules = [];
let policyRulesDirty = false;

function policySelect(value, options, onchange) {
  const select = document.createElement("select");
  for (const [v, label] of options) {
    const option = document.createElement("option");
    option.value = v;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener("change", onchange);
  return select;
}

function markPolicyRulesDirty() {
  policyRulesDirty = true;
  const save = document.getElementById("policyRulesSave");
  if (save) save.disabled = false;
}

function renderPolicyRules() {
  const root = document.getElementById("policyRules");
  if (!root) return;
  root.replaceChildren();
  if (!policyRules.length) {
    const empty = document.createElement("span");
    empty.style.color = "var(--dim)";
    empty.textContent = "No deterministic rules. Messages go to the normal decision path.";
    root.appendChild(empty);
  }
  policyRules.forEach(function(rule, index) {
    const row = document.createElement("div");
    row.className = "policy-rule";

    const action = policySelect(rule.action || "alarm", [["alarm","Alarm"],["ignore","Ignore"]], function() {
      policyRules[index].action = action.value;
      markPolicyRulesDirty();
    });
    const field = policySelect(rule.field || "author", [["author","Author"],["chat","Chat"],["text","Message text"]], function() {
      policyRules[index].field = field.value;
      markPolicyRulesDirty();
    });
    const match = policySelect(rule.match || "exact", [["exact","is exactly"],["contains","contains"]], function() {
      policyRules[index].match = match.value;
      markPolicyRulesDirty();
    });
    const value = document.createElement("input");
    value.type = "text";
    value.value = rule.value || "";
    value.placeholder = field.value === "text" ? "text to match" : "exact display name";
    value.addEventListener("input", function() {
      policyRules[index].value = value.value;
      markPolicyRulesDirty();
    });
    field.addEventListener("change", function() {
      value.placeholder = field.value === "text" ? "text to match" : "exact display name";
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Remove";
    remove.addEventListener("click", function() {
      policyRules.splice(index, 1);
      markPolicyRulesDirty();
      renderPolicyRules();
    });
    row.append(action, field, match, value, remove);
    root.appendChild(row);
  });
  const save = document.getElementById("policyRulesSave");
  if (save) save.disabled = !policyRulesDirty;
}

function addPolicyRule() {
  policyRules.push({ action:"alarm", field:"author", match:"exact", value:"" });
  markPolicyRulesDirty();
  renderPolicyRules();
}

async function loadPolicyRules(force) {
  if (!force && policyRulesDirty) return;
  try {
    const result = await api("/api/policy/rules");
    policyRules = Array.isArray(result.rules) ? result.rules : [];
    policyRulesDirty = false;
    renderPolicyRules();
  } catch { /* auth/transient; next refresh retries */ }
}

async function savePolicyRules() {
  if (policyRules.some(function(rule) { return !String(rule.value || "").trim(); })) {
    toast("Every deterministic rule needs a match value");
    return;
  }
  try {
    const result = await api("/api/policy/rules", {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ rules:policyRules }),
    });
    policyRules = result.rules || [];
    policyRulesDirty = false;
    renderPolicyRules();
    toast("Deterministic rules saved");
  } catch (e) { toast(e.message); }
}

loadPolicyRules(true);
setInterval(function() { loadPolicyRules(false); }, 5000);
</script>`;

export function injectPolicyUi(page) {
  if (page.includes('id="messagePolicyStyle"')) return page;
  let out = page
    .replace("</head>", POLICY_STYLE + "\n</head>")
    .replace('      <h1>Teams Automation</h1>\n', "")
    .replace('  <h2>Auto-send whitelist</h2>\n  <div class="card">\n    <div id="chips"></div>', '  <h2>Message policy</h2>\n  <div class="card">\n    <div class="policy-title">Auto-send whitelist</div>\n    <p class="policy-note">Used only when automatic replies are enabled. Exact chat names here may receive LLM-drafted auto-replies.</p>\n    <div id="chips"></div>')
    .replace('    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">\n      Empty = nothing ever auto-sends; every chat holds + escalates. Changes apply within one poll tick.\n    </p>\n  </div>\n\n  <h2>Brain context (user-profile.md)</h2>', '    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">Changes apply within one poll tick.</p>' + POLICY_RULES_HTML + '\n  </div>\n\n  <h2>Brain context (user-profile.md)</h2>')
    .replace('    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">\n      Everything here is sent to the model with every decision — keep it focused.\n      The orchestrator re-reads it each tick, so saving applies within seconds.\n    </p>\n', '    <p style="color:var(--dim);font-size:12px;margin:8px 0 0">The orchestrator re-reads it each tick, so saving applies within seconds.</p>\n');
  return out.replace("</body>", POLICY_SCRIPT + "\n</body>");
}
