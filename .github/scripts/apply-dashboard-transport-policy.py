from pathlib import Path
import json
import re


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


def sub_once(text, pattern, replacement, label):
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected one replacement, got {count}")
    return next_text


# gui-server-runtime.mjs
path = "src/gui-server-runtime.mjs"
s = read(path)
helper = '''function configuredFallbackTransport(alerts, primary) {
  if (Object.prototype.hasOwnProperty.call(alerts || {}, "fallbackTransport")) {
    const value = alerts.fallbackTransport;
    if (value === null || value === false || value === "none") return null;
    return String(value || "");
  }
  return primary === "fcm" ? "websocket" : "fcm";
}

'''
if "function configuredFallbackTransport(" not in s:
    s = s.replace("async function runtimeConfig() {", helper + "async function runtimeConfig() {")

runtime_config = '''async function runtimeConfig() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  const fcm = cfg.alerts?.fcm || {};
  const resolvedFcm = await resolveFcmConfig(fcm);
  const transport = cfg.alerts?.transport || "websocket";
  return {
    pollIntervalMs: cfg.pollIntervalMs || 15000,
    mode: cfg.automation?.mode || "respond",
    alerts: {
      transport,
      fallbackTransport: configuredFallbackTransport(cfg.alerts, transport),
      fcmProjectId: resolvedFcm.projectId,
      fcmRegistrationPresent: registrationFileExists(),
      fcmServiceAccountPresent: resolvedFcm.serviceAccountPresent,
      fcmServiceAccountValid: resolvedFcm.serviceAccountValid,
    },
  };
}'''
s = sub_once(s, r'async function runtimeConfig\(\) \{.*?\n\}', runtime_config, "runtimeConfig")

save_alert = '''async function saveAlertConfig(req) {
  const body = await readJsonBody(req);
  const transport = String(body.transport || "");
  if (!["websocket", "fcm"].includes(transport)) {
    throw Object.assign(new Error("transport must be websocket or fcm"), { httpCode: 400 });
  }

  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.alerts = cfg.alerts || {};
  const hasRequestedFallback = Object.prototype.hasOwnProperty.call(body, "fallbackTransport");
  const hadExplicitFallback = Object.prototype.hasOwnProperty.call(cfg.alerts, "fallbackTransport");
  let fallbackTransport = hasRequestedFallback
    ? body.fallbackTransport
    : hadExplicitFallback
      ? configuredFallbackTransport(cfg.alerts, cfg.alerts.transport || "websocket")
      : (transport === "fcm" ? "websocket" : "fcm");

  if (fallbackTransport === "none" || fallbackTransport === false) fallbackTransport = null;
  if (fallbackTransport !== null && fallbackTransport !== undefined) {
    fallbackTransport = String(fallbackTransport || "");
    if (!["websocket", "fcm"].includes(fallbackTransport)) {
      throw Object.assign(new Error("fallbackTransport must be websocket, fcm, or null"), { httpCode: 400 });
    }
    if (fallbackTransport === transport) {
      if (!hasRequestedFallback) fallbackTransport = transport === "fcm" ? "websocket" : "fcm";
      else throw Object.assign(new Error("fallbackTransport must differ from the primary transport"), { httpCode: 400 });
    }
  } else {
    fallbackTransport = null;
  }

  const nextFcm = {
    ...(cfg.alerts.fcm || {}),
    serviceAccountFile: cfg.alerts.fcm?.serviceAccountFile || DEFAULT_FCM_SERVICE_ACCOUNT_FILE,
  };
  delete nextFcm.projectId;
  const resolvedFcm = await resolveFcmConfig(nextFcm);
  if ((transport === "fcm" || fallbackTransport === "fcm") && !resolvedFcm.projectId) {
    throw Object.assign(new Error("Firebase project ID missing from service account"), { httpCode: 400 });
  }

  cfg.alerts.transport = transport;
  cfg.alerts.fallbackTransport = fallbackTransport;
  cfg.alerts.fcm = nextFcm;
  delete cfg.alerts.fcm.deviceToken;
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\\n");
  return await runtimeConfig();
}'''
s = sub_once(s, r'async function saveAlertConfig\(req\) \{.*?\n\}', save_alert, "saveAlertConfig")

transport_html = '''    <div style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <div>
        <strong>Phone notification delivery</strong>
        <div style="color:var(--dim);font-size:12px">The primary transport is tried first. Fallback is optional.</div>
      </div>
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <label style="display:flex;flex-direction:column;gap:4px;color:var(--dim);font-size:12px">
          Primary
          <select id="alertTransport" onchange="renderAlertTransportFields()"
            style="background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
            <option value="websocket">WebSocket</option>
            <option value="fcm">Firebase Cloud Messaging</option>
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;color:var(--dim);font-size:12px">
          Fallback
          <select id="alertFallbackTransport" onchange="renderAlertTransportFields(this.value)"
            style="background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          </select>
        </label>
        <button class="secondary" onclick="saveAlertTransport()">Save</button>
      </div>
      <div id="fcmFields" style="margin-top:10px">
        <div id="fcmStatus" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
    </div>
'''
s = sub_once(
    s,
    r'    <div style="border-top:1px solid var\(--line\);margin-top:12px;padding-top:12px">\n      <div class="row" style="justify-content:space-between">.*?    </p>\n',
    transport_html,
    "transport HTML",
)

apply_runtime = '''function transportName(value) {
  return value === "fcm" ? "Firebase Cloud Messaging" : "WebSocket";
}
function renderFcmConfigStatus(c) {
  const status = document.getElementById("fcmStatus");
  if (!status) return;
  const rows = [
    {
      label: "Firebase project",
      value: c.alerts?.fcmProjectId || "missing",
      ok: !!c.alerts?.fcmProjectId,
      detail: "Identifies the Firebase project this PC sends through.",
    },
    {
      label: "Service account",
      value: c.alerts?.fcmServiceAccountValid ? "valid" : c.alerts?.fcmServiceAccountPresent ? "invalid" : "missing",
      ok: !!c.alerts?.fcmServiceAccountValid,
      detail: "Credentials used by this PC to authenticate to Firebase Cloud Messaging.",
    },
    {
      label: "Phone registration",
      value: c.alerts?.fcmRegistrationPresent ? "present" : "missing",
      ok: !!c.alerts?.fcmRegistrationPresent,
      detail: "A stored phone registration identifier tells FCM which app instance to target.",
    },
  ];
  status.replaceChildren();
  for (const row of rows) {
    const line = document.createElement("div");
    line.style.cssText = "display:grid;grid-template-columns:130px minmax(90px,auto) 1fr;gap:8px;align-items:baseline;font-size:12px";
    const label = document.createElement("strong");
    label.textContent = row.label;
    const value = document.createElement("span");
    value.textContent = row.value;
    value.style.color = row.ok ? "var(--ok)" : "var(--bad)";
    const detail = document.createElement("span");
    detail.textContent = row.detail;
    detail.style.color = "var(--dim)";
    line.append(label, value, detail);
    status.appendChild(line);
  }
}
function applyRuntimeConfig(c) {
  const input = document.getElementById("pollIntervalSec");
  if (input && document.activeElement !== input) input.value = String(c.pollIntervalMs / 1000);
  const transport = c.alerts?.transport || "websocket";
  const transportSelect = document.getElementById("alertTransport");
  if (transportSelect && document.activeElement !== transportSelect) transportSelect.value = transport;
  renderAlertTransportFields(c.alerts?.fallbackTransport == null ? "none" : c.alerts.fallbackTransport);
  renderFcmConfigStatus(c);

  const alertOnly = c.mode === "alert-only";
  const whitelistHeading = [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Auto-send whitelist");
  if (whitelistHeading) {
    whitelistHeading.style.display = alertOnly ? "none" : "";
    if (whitelistHeading.nextElementSibling) whitelistHeading.nextElementSibling.style.display = alertOnly ? "none" : "";
  }
  const alarmHeading = [...document.querySelectorAll("h2")].find((h) => ["Escalations", "Alarms"].includes(h.textContent.trim()));
  if (alarmHeading) alarmHeading.textContent = alertOnly ? "Alarms" : "Escalations";
}'''
s = sub_once(s, r'function applyRuntimeConfig\(c\) \{.*?\n\}', apply_runtime, "applyRuntimeConfig")

transport_script = '''function renderAlertTransportFields(preferredFallback) {
  const primary = document.getElementById("alertTransport")?.value || "websocket";
  const fallbackSelect = document.getElementById("alertFallbackTransport");
  if (!fallbackSelect) return;
  const other = primary === "fcm" ? "websocket" : "fcm";
  const previous = preferredFallback === undefined
    ? (fallbackSelect.value || other)
    : (preferredFallback || "none");
  const fallbackEnabled = previous !== "none";

  fallbackSelect.replaceChildren();
  const none = document.createElement("option");
  none.value = "none";
  none.textContent = "None";
  const alternate = document.createElement("option");
  alternate.value = other;
  alternate.textContent = transportName(other);
  fallbackSelect.append(none, alternate);
  fallbackSelect.value = fallbackEnabled ? other : "none";

  const fields = document.getElementById("fcmFields");
  if (fields) fields.style.display = (primary === "fcm" || fallbackSelect.value === "fcm") ? "block" : "none";
}
async function saveAlertTransport() {
  const transport = document.getElementById("alertTransport").value;
  const fallbackValue = document.getElementById("alertFallbackTransport").value;
  const fallbackTransport = fallbackValue === "none" ? null : fallbackValue;
  try {
    const result = await tunnelApi("/api/config/alerts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport, fallbackTransport }),
    });
    applyRuntimeConfig(result);
    toast("Phone delivery policy saved");
  } catch (e) { toast(e.message); }
}'''
s = sub_once(s, r'function renderAlertTransportFields\(\) \{.*?\n\}\nasync function saveAlertTransport\(\) \{.*?\n\}', transport_script, "transport script")
write(path, s)


# alerts.mjs
path = "src/alerts.mjs"
s = read(path)
s = s.replace(
    "// Phone alert delivery. config.alerts.transport is the preferred transport;\n// the other transport is available as fallback.",
    "// Phone alert delivery. config.alerts.transport is primary; alerts.fallbackTransport\n// selects an optional fallback. Missing fallbackTransport preserves the legacy other-transport fallback.",
)
s = s.replace(
    "  recordFcmBackoff,\n  recordTransportFailure,",
    "  recordFcmBackoff,\n  recordPrimaryOnlyFailure,\n  recordTransportFailure,",
)
if "export function resolveFallbackTransport" not in s:
    s = s.replace(
        '''function otherTransport(transport) {
  return transport === "fcm" ? "websocket" : "fcm";
}
''',
        '''function otherTransport(transport) {
  return transport === "fcm" ? "websocket" : "fcm";
}

export function resolveFallbackTransport(config, primary) {
  const alerts = config?.alerts || {};
  if (!Object.prototype.hasOwnProperty.call(alerts, "fallbackTransport")) {
    return otherTransport(primary);
  }
  const value = alerts.fallbackTransport;
  if (value === null || value === false || value === "none") return null;
  const fallback = String(value || "");
  if (!["websocket", "fcm"].includes(fallback)) {
    throw new Error(`unknown alerts.fallbackTransport: "${fallback}"`);
  }
  if (fallback === primary) {
    throw new Error("alerts.fallbackTransport must differ from alerts.transport");
  }
  return fallback;
}
''',
    )

s = s.replace("  const secondary = otherTransport(primary);", "  const secondary = resolveFallbackTransport(config, primary);")
s = s.replace(
    '''  const runtime = await readAlertRuntime(primary);
  if (runtime.delivery.state === "fallback") {
    return await sendWhileFallback(body, config, primary, secondary);
  }
  return await sendPrimaryFirst(body, config, primary, secondary);
}

async function sendPrimaryFirst''',
    '''  if (!secondary) return await sendPrimaryOnly(body, config, primary);

  const runtime = await readAlertRuntime(primary);
  if (runtime.delivery.state === "fallback") {
    return await sendWhileFallback(body, config, primary, secondary);
  }
  return await sendPrimaryFirst(body, config, primary, secondary);
}

async function sendPrimaryOnly(body, config, primary) {
  const attempts = [];
  const result = await attempt(primary, body, config).catch((error) => ({ error }));
  if (!result.error) {
    await recordTransportSuccess(primary, primary, transportResultOptions(primary, result));
    attempts.push({ transport: primary, ok: true, ...result });
    return { alertId: body.alertId, transport: primary, attempts };
  }

  const error = result.error;
  const classification = classifyFailure(primary, error);
  attempts.push(failedAttempt(primary, error, classification));
  if (!(primary === "fcm" && classification.backoffActive)) {
    const failedState = await recordPrimaryOnlyFailure(primary, primary, {
      error: errorSummary(error),
      registrationInvalid: classification.registrationInvalid,
      ...transportResultOptions(primary, error),
    });
    if (primary === "fcm" && classification.retryAfterMs > 0 && !failedState.ignoredStaleFcmResult) {
      await recordFcmBackoff(primary, {
        error: errorSummary(error),
        delayMs: classification.retryAfterMs,
        ...transportResultOptions(primary, error),
      });
    }
  }
  throw deliveryError(body.alertId, attempts);
}

async function sendPrimaryFirst''',
)

old_recovery = '''    if (classification.registrationInvalid) {
      const failedState = await markFcmRegistrationSuspect(
        primary,
        classification.code || "fcm_registration_invalid",
        generationOptions
      );
      if (!failedState.ignoredStaleFcmResult) {
        publishWorkerEvent(config, {
          type: "fcm_registration_invalid",
          actions: ["ensure_fcm_registration", "start_ws"],
          error: errorSummary(error),
        }).catch(() => {});
      }
    } else if (classification.retryAfterMs > 0) {'''
new_recovery = '''    if (classification.registrationInvalid) {
      const fallback = resolveFallbackTransport(config, primary);
      const failedState = fallback
        ? await markFcmRegistrationSuspect(
            primary,
            classification.code || "fcm_registration_invalid",
            generationOptions
          )
        : await recordPrimaryOnlyFailure(primary, primary, {
            error: errorSummary(error),
            registrationInvalid: true,
            ...generationOptions,
          });
      if (fallback === "websocket" && !failedState.ignoredStaleFcmResult) {
        publishWorkerEvent(config, {
          type: "fcm_registration_invalid",
          actions: ["ensure_fcm_registration", "start_ws"],
          error: errorSummary(error),
        }).catch(() => {});
      }
    } else if (classification.retryAfterMs > 0) {'''
if old_recovery not in s:
    raise RuntimeError("alerts recovery block not found")
s = s.replace(old_recovery, new_recovery, 1)
write(path, s)


# alert-runtime.mjs
path = "src/alert-runtime.mjs"
s = read(path)
if "export async function recordPrimaryOnlyFailure" not in s:
    marker = "export async function recordFcmBackoff("
    insert = '''export async function recordPrimaryOnlyFailure(
  transport,
  primaryTransport,
  { error = null, registrationInvalid = false, registrationGeneration = null } = {}
) {
  const mutate = (runtime) => {
    runtime.delivery.failures[transport] = (runtime.delivery.failures[transport] || 0) + 1;
    runtime.delivery.state = "primary_failed";
    runtime.delivery.activeTransport = primaryTransport;
    runtime.recoveryReason = error || `${transport}_failed`;
    runtime.websocketWanted = primaryTransport === "websocket";
    if (transport === "fcm") {
      runtime.fcm.lastError = error || null;
      if (registrationInvalid) {
        runtime.fcm.registration = "suspect";
        runtime.fcm.nextAttemptAt = null;
        runtime.fcm.backoffMs = 0;
      }
    }
    return runtime;
  };

  if (transport === "fcm") {
    return await mutateForFcmGeneration(primaryTransport, registrationGeneration, mutate);
  }
  return await updateAlertRuntime(primaryTransport, mutate);
}

'''
    if marker not in s:
        raise RuntimeError("recordFcmBackoff marker not found")
    s = s.replace(marker, insert + marker, 1)

control_state = '''export async function controlState(config) {
  const primaryTransport = config?.alerts?.transport || "websocket";
  const alerts = config?.alerts || {};
  const fallbackTransport = Object.prototype.hasOwnProperty.call(alerts, "fallbackTransport")
    ? (alerts.fallbackTransport === null || alerts.fallbackTransport === false || alerts.fallbackTransport === "none"
        ? null
        : String(alerts.fallbackTransport || ""))
    : (primaryTransport === "fcm" ? "websocket" : "fcm");
  const runtime = await readAlertRuntime(primaryTransport);
  const registration = await readFcmRegistration();
  const delivery = { ...runtime.delivery };
  if (!fallbackTransport && delivery.state === "fallback") {
    delivery.state = "primary_failed";
    delivery.activeTransport = primaryTransport;
  }
  return {
    primaryTransport,
    fallbackTransport,
    delivery,
    websocketWanted: primaryTransport === "websocket" || (fallbackTransport === "websocket" && !!runtime.websocketWanted),
    fcm: {
      registrationStatus: runtime.fcm.registration,
      registrationPresent: !!registration,
      registrationKind: registration?.kind || null,
      registrationGeneration: registration?.generation ?? null,
      registrationUpdatedAt: registration?.updatedAt || null,
      lastError: runtime.fcm.lastError,
      lastSuccessAt: runtime.fcm.lastSuccessAt,
      nextAttemptAt: runtime.fcm.nextAttemptAt,
      backoffMs: runtime.fcm.backoffMs,
    },
    controlWorker: {
      enabled: !!config?.controlWorker?.enabled,
      url: config?.controlWorker?.enabled ? String(config.controlWorker.url || "") : "",
    },
    updatedAt: runtime.updatedAt,
  };
}'''
s = sub_once(s, r'export async function controlState\(config\) \{.*?\n\}', control_state, "controlState")
write(path, s)


# dashboard layout
path = "src/gui-dashboard-layout.mjs"
s = read(path)
s = s.replace(
    "  main { max-width:1600px; padding:14px 18px 24px; }",
    "  main { width:100%; max-width:none; margin:0; padding:14px 18px 24px; }",
)
s = s.replace(
    "  .dashboard-split { display:grid; grid-template-columns:minmax(360px,.82fr) minmax(520px,1.35fr); gap:18px; align-items:start; }",
    "  .dashboard-split { display:grid; grid-template-columns:clamp(480px,36vw,620px) minmax(0,1fr); gap:18px; align-items:start; }",
)
if ".brain-file-note" not in s:
    s = s.replace(
        "  .dashboard-left #profile { min-height:260px; }",
        "  .dashboard-left #profile { min-height:260px; }\n  .brain-file-note { color:var(--dim); font-size:12px; margin:0 0 8px; }\n  .brain-file-note code { color:var(--fg); }",
    )
s = s.replace(
    '''  const profile = document.getElementById("profile");
  if (profile) profile.setAttribute("rows", "18");''',
    '''  const profile = document.getElementById("profile");
  if (profile) {
    profile.setAttribute("rows", "18");
    const card = profile.closest(".card");
    if (card && !card.querySelector(".brain-file-note")) {
      const note = document.createElement("div");
      note.className = "brain-file-note";
      note.innerHTML = 'Stored in <code>context/user-profile.md</code>';
      card.insertBefore(note, profile);
    }
  }''',
)
write(path, s)


# config example
path = "config/config.example.json"
cfg = json.loads(read(path))
alerts = cfg.setdefault("alerts", {})
alerts["fallbackTransport"] = "fcm" if alerts.get("transport", "websocket") == "websocket" else "websocket"
write(path, json.dumps(cfg, indent=2) + "\n")


# actions description
path = "src/actions.mjs"
s = read(path)
s = s.replace(
    '    "Push an alert to the user\'s phone. config.alerts.transport selects the preferred " +\n    "transport (WebSocket or FCM); alerts.mjs may use the other transport as fallback.",',
    '    "Push an alert to the user\'s phone. config.alerts.transport selects the primary " +\n    "transport; config.alerts.fallbackTransport optionally selects a fallback.",',
)
write(path, s)


# smoke tests
path = "scripts/smoke-alert-state.mjs"
s = read(path)
s = s.replace(
    "  recordFcmBackoff,\n  recordTransportFailure,",
    "  recordFcmBackoff,\n  recordPrimaryOnlyFailure,\n  recordTransportFailure,",
)
if 'resolveFallbackTransport' not in s:
    s = s.replace(
        'from "../src/alert-runtime.mjs";\n',
        'from "../src/alert-runtime.mjs";\nimport { resolveFallbackTransport } from "../src/alerts.mjs";\n',
        1,
    )
    s = s.replace(
        'try {\n  let state = await readAlertRuntime("fcm");',
        'try {\n  assert(resolveFallbackTransport({ alerts: {} }, "fcm") === "websocket", "legacy config defaults to other transport fallback");\n  assert(resolveFallbackTransport({ alerts: { fallbackTransport: null } }, "fcm") === null, "explicit null disables fallback");\n  assert(resolveFallbackTransport({ alerts: { fallbackTransport: "fcm" } }, "websocket") === "fcm", "explicit fallback is honored");\n\n  let state = await readAlertRuntime("fcm");',
        1,
    )
    s = s.replace(
        '  console.log("alert runtime smoke: ok");',
        '''  await clean();
  state = await recordPrimaryOnlyFailure("fcm", "fcm", {
    error: "primary-only failure",
    registrationInvalid: true,
  });
  assert(state.delivery.state === "primary_failed", "primary-only failure does not enter fallback");
  assert(state.delivery.activeTransport === "fcm", "primary-only failure keeps FCM active");
  assert(state.websocketWanted === false, "primary-only FCM failure does not request WebSocket");
  assert(state.fcm.registration === "suspect", "primary-only invalid registration is still tracked");
  state = await recordTransportSuccess("fcm", "fcm");
  assert(state.delivery.state === "primary_working", "primary-only success recovers primary state");

  console.log("alert runtime smoke: ok");''',
        1,
    )
write(path, s)


# AGENTS wording
path = "AGENTS.md"
s = read(path)
s = s.replace(
    "  alerts.mjs        Preferred/fallback FCM + WebSocket delivery and recovery.",
    "  alerts.mjs        Configurable primary FCM/WebSocket delivery, optional fallback, and recovery.",
)
write(path, s)

print("patch applied")
