from pathlib import Path
import json


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected marker not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Keep Firebase credentials/config out of the public repository.
gitignore = Path(".gitignore")
gi = gitignore.read_text()
for entry in ["config/fcm-service-account.json", "android-app/app/google-services.json"]:
    if entry not in gi.splitlines():
        gi += entry + "\n"
gitignore.write_text(gi)

# Device token becomes runtime state rather than tracked config.
config_path = Path("config/config.json")
cfg = json.loads(config_path.read_text())
fcm = cfg.setdefault("alerts", {}).setdefault("fcm", {})
fcm.setdefault("projectId", "")
fcm["serviceAccountFile"] = "config/fcm-service-account.json"
fcm.pop("deviceToken", None)
config_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")

# Server FCM sender reads the current registration token from gitignored data/.
replace_once(
    "src/alerts.mjs",
    'import { fileURLToPath } from "node:url";\n',
    'import { fileURLToPath } from "node:url";\nimport { DATA_DIR } from "./state.mjs";\n',
)
replace_once(
    "src/alerts.mjs",
    'const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";\n',
    'const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";\nconst FCM_DEVICE_TOKEN_FILE = join(DATA_DIR, "fcm-device-token.txt");\n',
)
replace_once(
    "src/alerts.mjs",
    '''async function sendViaFcm(body, fcm) {
  if (!fcm?.projectId || !fcm?.deviceToken || !fcm?.serviceAccountFile) {
    throw new Error(
      "alerts.fcm not configured — need projectId, deviceToken (from the app), and serviceAccountFile"
    );
  }
  const saPath = join(ROOT, fcm.serviceAccountFile);
''',
    '''async function sendViaFcm(body, fcm) {
  if (!fcm?.projectId || !fcm?.serviceAccountFile) {
    throw new Error("alerts.fcm not configured — need projectId and serviceAccountFile");
  }
  let deviceToken = "";
  try { deviceToken = (await readFile(FCM_DEVICE_TOKEN_FILE, "utf8")).trim(); } catch { /* not registered yet */ }
  if (!deviceToken) {
    throw new Error("FCM device token not registered — open the Android app while the GUI/tunnel is reachable");
  }
  const saPath = join(ROOT, fcm.serviceAccountFile);
''',
)
replace_once("src/alerts.mjs", "        token: fcm.deviceToken,\n", "        token: deviceToken,\n")

# Runtime API: transport selection, project ID, device-token registration and status.
runtime = Path("src/gui-server-runtime.mjs")
s = runtime.read_text()
s = s.replace(
    'import { readFile, writeFile } from "node:fs/promises";',
    'import { mkdir, readFile, writeFile } from "node:fs/promises";',
    1,
)
s = s.replace(
    'const CONFIG_FILE = join(ROOT, "config", "config.json");\n',
    'const CONFIG_FILE = join(ROOT, "config", "config.json");\nconst FCM_DEVICE_TOKEN_FILE = join(DATA_DIR, "fcm-device-token.txt");\n',
    1,
)
old_runtime_config = '''async function runtimeConfig() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  return {
    pollIntervalMs: cfg.pollIntervalMs || 15000,
    mode: cfg.automation?.mode || "respond",
  };
}
'''
new_runtime_config = '''async function runtimeConfig() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  const fcm = cfg.alerts?.fcm || {};
  let fcmTokenRegistered = false;
  try { fcmTokenRegistered = !!(await readFile(FCM_DEVICE_TOKEN_FILE, "utf8")).trim(); } catch { /* no token */ }
  const serviceAccountFile = fcm.serviceAccountFile || "config/fcm-service-account.json";
  return {
    pollIntervalMs: cfg.pollIntervalMs || 15000,
    mode: cfg.automation?.mode || "respond",
    alerts: {
      transport: cfg.alerts?.transport || "websocket",
      fcmProjectId: fcm.projectId || "",
      fcmTokenRegistered,
      fcmServiceAccountPresent: existsSync(join(ROOT, serviceAccountFile)),
    },
  };
}

async function saveAlertConfig(req) {
  const body = await readJsonBody(req);
  const transport = String(body.transport || "");
  const projectId = String(body.projectId || "").trim();
  if (!["websocket", "fcm"].includes(transport)) {
    throw Object.assign(new Error("transport must be websocket or fcm"), { httpCode: 400 });
  }
  if (projectId.length > 128) {
    throw Object.assign(new Error("Firebase project ID is too long"), { httpCode: 400 });
  }
  if (transport === "fcm" && !projectId) {
    throw Object.assign(new Error("Firebase project ID is required for FCM"), { httpCode: 400 });
  }
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  cfg.alerts = cfg.alerts || {};
  cfg.alerts.transport = transport;
  cfg.alerts.fcm = {
    ...(cfg.alerts.fcm || {}),
    projectId,
    serviceAccountFile: cfg.alerts.fcm?.serviceAccountFile || "config/fcm-service-account.json",
  };
  delete cfg.alerts.fcm.deviceToken;
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\\n");
  return await runtimeConfig();
}

async function registerFcmToken(req) {
  const body = await readJsonBody(req);
  const deviceToken = typeof body.token === "string" ? body.token.trim() : "";
  if (deviceToken.length < 20 || deviceToken.length > 4096) {
    throw Object.assign(new Error("invalid FCM registration token"), { httpCode: 400 });
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FCM_DEVICE_TOKEN_FILE, deviceToken + "\\n", { mode: 0o600 });
  return { registered: true };
}
'''
if old_runtime_config not in s:
    raise SystemExit("runtimeConfig marker not found")
s = s.replace(old_runtime_config, new_runtime_config, 1)

poll_section = '''    <div class="row" style="justify-content:space-between;border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <div>
        <strong>Polling interval</strong>
        <div style="color:var(--dim);font-size:12px">Applies live; no orchestrator restart required.</div>
      </div>
      <div class="row">
        <input id="pollIntervalSec" type="number" min="1" max="300" step="0.5"
          style="width:90px;background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
        <span style="color:var(--dim)">seconds</span>
        <button class="secondary" onclick="savePollInterval()">Save</button>
      </div>
    </div>
'''
transport_section = poll_section + '''
    <div style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <div class="row" style="justify-content:space-between">
        <div>
          <strong>Phone notification transport</strong>
          <div style="color:var(--dim);font-size:12px">Exactly one transport sends each alarm.</div>
        </div>
        <div class="row">
          <select id="alertTransport" onchange="renderAlertTransportFields()"
            style="background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
            <option value="websocket">WebSocket</option>
            <option value="fcm">Firebase Cloud Messaging</option>
          </select>
          <button class="secondary" onclick="saveAlertTransport()">Save</button>
        </div>
      </div>
      <div id="fcmFields" style="margin-top:10px">
        <div class="row">
          <input id="fcmProjectId" type="text" placeholder="Firebase project ID"
            style="min-width:260px;background:#0c0e12;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          <span id="fcmStatus" style="color:var(--dim);font-size:12px"></span>
        </div>
      </div>
    </div>
'''
if poll_section not in s:
    raise SystemExit("poll UI marker not found")
s = s.replace(poll_section, transport_section, 1)

old_apply = '''function applyRuntimeConfig(c) {
  const input = document.getElementById("pollIntervalSec");
  if (input && document.activeElement !== input) input.value = String(c.pollIntervalMs / 1000);
  const alertOnly = c.mode === "alert-only";
'''
new_apply = '''function applyRuntimeConfig(c) {
  const input = document.getElementById("pollIntervalSec");
  if (input && document.activeElement !== input) input.value = String(c.pollIntervalMs / 1000);
  const transport = c.alerts?.transport || "websocket";
  const transportSelect = document.getElementById("alertTransport");
  if (transportSelect && document.activeElement !== transportSelect) transportSelect.value = transport;
  const project = document.getElementById("fcmProjectId");
  if (project && document.activeElement !== project) project.value = c.alerts?.fcmProjectId || "";
  const status = document.getElementById("fcmStatus");
  if (status) {
    const parts = [
      c.alerts?.fcmServiceAccountPresent ? "service account ✓" : "service account missing",
      c.alerts?.fcmTokenRegistered ? "phone token ✓" : "phone token missing",
    ];
    status.textContent = parts.join(" · ");
  }
  renderAlertTransportFields();
  const alertOnly = c.mode === "alert-only";
'''
if old_apply not in s:
    raise SystemExit("applyRuntimeConfig marker not found")
s = s.replace(old_apply, new_apply, 1)

save_poll_marker = '''async function savePollInterval() {
  const seconds = Number(document.getElementById("pollIntervalSec").value);
'''
insert_transport_js = '''function renderAlertTransportFields() {
  const fcm = document.getElementById("alertTransport")?.value === "fcm";
  const fields = document.getElementById("fcmFields");
  if (fields) fields.style.display = fcm ? "block" : "none";
}
async function saveAlertTransport() {
  const transport = document.getElementById("alertTransport").value;
  const projectId = document.getElementById("fcmProjectId").value.trim();
  try {
    const result = await tunnelApi("/api/config/alerts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport, projectId }),
    });
    applyRuntimeConfig(result);
    toast(transport === "fcm" ? "FCM selected" : "WebSocket selected");
  } catch (e) { toast(e.message); }
}
'''
if save_poll_marker not in s:
    raise SystemExit("savePollInterval marker not found")
s = s.replace(save_poll_marker, insert_transport_js + save_poll_marker, 1)

old_route_gate = '    if (url.pathname.startsWith("/api/tunnel/") || url.pathname === "/api/runtime/config" || url.pathname === "/api/config/poll-interval") {'
new_route_gate = '    if (url.pathname.startsWith("/api/tunnel/") || url.pathname === "/api/runtime/config" || url.pathname === "/api/config/poll-interval" || url.pathname === "/api/config/alerts" || url.pathname === "/api/fcm/register") {'
if old_route_gate not in s:
    raise SystemExit("runtime route gate marker not found")
s = s.replace(old_route_gate, new_route_gate, 1)
handler_marker = '''        if (req.method === "PUT" && url.pathname === "/api/config/poll-interval") {
          return sendJson(res, 200, { ok: true, ...(await savePollInterval(req)) });
        }
'''
handler_add = handler_marker + '''        if (req.method === "PUT" && url.pathname === "/api/config/alerts") {
          return sendJson(res, 200, await saveAlertConfig(req));
        }
        if (req.method === "POST" && url.pathname === "/api/fcm/register") {
          return sendJson(res, 200, { ok: true, ...(await registerFcmToken(req)) });
        }
'''
if handler_marker not in s:
    raise SystemExit("runtime handler marker not found")
s = s.replace(handler_marker, handler_add, 1)
runtime.write_text(s)

# Log FCM token registration requests server-side, without token contents.
diag = Path("src/gui-server.mjs")
s = diag.read_text()
s = s.replace(
    '    if (url.pathname === "/api/alerts" || url.pathname === "/api/tunnel/start" || url.pathname === "/api/tunnel/stop") {',
    '    if (url.pathname === "/api/alerts" || url.pathname === "/api/fcm/register" || url.pathname === "/api/tunnel/start" || url.pathname === "/api/tunnel/stop") {',
    1,
)
s = s.replace(
    '        logDiagnostic(url.pathname === "/api/alerts" ? "alert_http" : "tunnel_control_http", {',
    '        const kind = url.pathname === "/api/alerts" ? "alert_http" : url.pathname === "/api/fcm/register" ? "fcm_register_http" : "tunnel_control_http";\n        logDiagnostic(kind, {',
    1,
)
diag.write_text(s)

# Firebase Android SDK. Plugin is conditional so WebSocket-only builds still compile
# before google-services.json is configured.
replace_once(
    "android-app/build.gradle.kts",
    '    id("org.jetbrains.kotlin.android") version "2.0.20" apply false\n',
    '    id("org.jetbrains.kotlin.android") version "2.0.20" apply false\n    id("com.google.gms.google-services") version "4.5.0" apply false\n',
)
app_gradle = Path("android-app/app/build.gradle.kts")
s = app_gradle.read_text()
s = s.replace(
    '''plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
''',
    '''plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
''',
    1,
)
s = s.replace(
    '    implementation("com.squareup.okhttp3:okhttp:4.12.0")\n',
    '    implementation("com.squareup.okhttp3:okhttp:4.12.0")\n    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))\n    implementation("com.google.firebase:firebase-messaging")\n',
    1,
)
app_gradle.write_text(s)

# FCM receiver service.
manifest = Path("android-app/app/src/main/AndroidManifest.xml")
s = manifest.read_text()
service_marker = '''        <service
            android:name=".AlertService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />
'''
fcm_manifest = service_marker + '''
        <service
            android:name=".FcmMessagingService"
            android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
'''
if service_marker not in s:
    raise SystemExit("manifest AlertService marker not found")
manifest.write_text(s.replace(service_marker, fcm_manifest, 1))

# Remember last transport learned from the server so the app can stop/start the
# WebSocket foreground service appropriately even across activity restarts.
prefs = Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/Prefs.kt")
s = prefs.read_text()
s = s.replace(
    '''    var token: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(value) = sp.edit().putString(KEY_TOKEN, value).apply()
''',
    '''    var token: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(value) = sp.edit().putString(KEY_TOKEN, value).apply()

    var alertTransport: String
        get() = sp.getString(KEY_ALERT_TRANSPORT, "websocket") ?: "websocket"
        set(value) = sp.edit().putString(KEY_ALERT_TRANSPORT, value).apply()
''',
    1,
)
s = s.replace(
    '        private const val KEY_TOKEN = "token"\n',
    '        private const val KEY_TOKEN = "token"\n        private const val KEY_ALERT_TRANSPORT = "alert_transport"\n',
    1,
)
prefs.write_text(s)

# Add an explicit stop helper for FCM mode.
alert_service = Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/AlertService.kt")
s = alert_service.read_text()
start_marker = '''        fun start(context: Context) {
            AppLog.event(context, "service_start_requested")
            val i = Intent(context, AlertService::class.java)
            ContextCompat.startForegroundService(context, i)
        }
'''
start_replacement = start_marker + '''
        fun stop(context: Context) {
            AppLog.event(context, "service_stop_requested", "reason=transport_fcm")
            context.stopService(Intent(context, AlertService::class.java))
            AlertState.onConnection(context, AlertState.Connection.DISCONNECTED)
        }
'''
if start_marker not in s:
    raise SystemExit("AlertService start marker not found")
alert_service.write_text(s.replace(start_marker, start_replacement, 1))

# Transport sync: server is the source of truth; FCM mode stops the persistent socket.
Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/NotificationTransport.kt").write_text(r'''package com.guymichaely.teamsmonitor

import android.content.Context
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

object NotificationTransport {
    private val client = OkHttpClient()

    fun sync(context: Context) {
        val app = context.applicationContext
        val prefs = Prefs(app)
        if (prefs.serverUrl.isBlank()) {
            apply(app, prefs.alertTransport)
            return
        }
        val request = Request.Builder()
            .url(prefs.serverUrl.trimEnd('/') + "/api/runtime/config")
            .apply { if (prefs.token.isNotBlank()) header("Authorization", "Bearer ${prefs.token}") }
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.event(app, "transport_sync_failed", "error=${e.javaClass.simpleName}:${e.message ?: ""}")
                apply(app, prefs.alertTransport)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        AppLog.event(app, "transport_sync_failed", "http=${it.code}")
                        apply(app, prefs.alertTransport)
                        return
                    }
                    val body = runCatching { JSONObject(it.body?.string().orEmpty()) }.getOrNull()
                    val transport = body?.optJSONObject("alerts")?.optString("transport", "websocket")
                        ?.takeIf { value -> value == "websocket" || value == "fcm" }
                        ?: "websocket"
                    prefs.alertTransport = transport
                    AppLog.event(app, "transport_synced", "transport=$transport")
                    apply(app, transport)
                }
            }
        })
    }

    private fun apply(context: Context, transport: String) {
        if (transport == "fcm") {
            AlertService.stop(context)
            FcmRegistration.syncCurrentToken(context)
        } else {
            AlertService.start(context)
        }
    }
}
''')

Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/FcmRegistration.kt").write_text(r'''package com.guymichaely.teamsmonitor

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

object FcmRegistration {
    private val client = OkHttpClient()
    private val jsonType = "application/json".toMediaType()

    fun syncCurrentToken(context: Context) {
        val app = context.applicationContext
        if (FirebaseApp.getApps(app).isEmpty()) {
            AppLog.event(app, "fcm_unavailable", "reason=google_services_not_configured")
            return
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                AppLog.event(app, "fcm_token_failed", "error=${task.exception?.message ?: "unknown"}")
                return@addOnCompleteListener
            }
            syncToken(app, task.result)
        }
    }

    fun syncToken(context: Context, fcmToken: String) {
        val app = context.applicationContext
        val prefs = Prefs(app)
        if (prefs.serverUrl.isBlank()) {
            AppLog.event(app, "fcm_register_skipped", "reason=server_not_configured tokenLength=${fcmToken.length}")
            return
        }
        val body = JSONObject().put("token", fcmToken).toString().toRequestBody(jsonType)
        val request = Request.Builder()
            .url(prefs.serverUrl.trimEnd('/') + "/api/fcm/register")
            .post(body)
            .apply { if (prefs.token.isNotBlank()) header("Authorization", "Bearer ${prefs.token}") }
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.event(app, "fcm_register_failed", "error=${e.javaClass.simpleName}:${e.message ?: ""} tokenLength=${fcmToken.length}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    AppLog.event(app, if (it.isSuccessful) "fcm_registered" else "fcm_register_failed", "http=${it.code} tokenLength=${fcmToken.length}")
                }
            }
        })
    }
}
''')

Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/FcmMessagingService.kt").write_text(r'''package com.guymichaely.teamsmonitor

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        AppLog.event(this, "fcm_new_token", "tokenLength=${token.length}")
        FcmRegistration.syncToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val chat = data["chat"].orEmpty()
        val author = data["author"].orEmpty()
        val text = data["text"].orEmpty()
        val time = data["time"].orEmpty()
        AppLog.event(
            this,
            "fcm_message_received",
            "messageId=${message.messageId ?: ""} chat=$chat author=$author serverTime=$time textLength=${text.length} priority=${message.priority}"
        )
        AlertState.onAlert(this, chat, author, text, time)
        AlertNotifier.alert(this, chat, author, text)
    }

    override fun onDeletedMessages() {
        AppLog.event(this, "fcm_messages_deleted")
    }
}
''')

# Main screen syncs the server-selected transport whenever the app is foregrounded.
main = Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/MainActivity.kt")
s = main.read_text()
s = s.replace("        AlertService.start(this)\n        requestNotifPermission()\n", "        requestNotifPermission()\n", 1)
s = s.replace(
    '''        refreshStatus()
        refreshTestButton()
        refreshToggles()
''',
    '''        NotificationTransport.sync(this)
        refreshStatus()
        refreshTestButton()
        refreshToggles()
''',
    1,
)
s = s.replace(
    '''        findViewById<TextView>(R.id.conn_status).text = "WebSocket: $conn"
''',
    '''        findViewById<TextView>(R.id.conn_status).text =
            if (prefs.alertTransport == "fcm") "Notifications: Firebase Cloud Messaging"
            else "WebSocket: $conn"
''',
    1,
)
main.write_text(s)

# Settings save triggers a fresh server transport sync rather than always reconnecting WS.
settings = Path("android-app/app/src/main/java/com/guymichaely/teamsmonitor/SettingsActivity.kt")
s = settings.read_text().replace("            AlertService.reconnect(this)\n", "            NotificationTransport.sync(this)\n", 1)
settings.write_text(s)

# CI optionally restores google-services.json from a repository secret. Builds still
# succeed without it so the WebSocket transport remains usable during setup.
workflow = Path(".github/workflows/android-apk.yml")
s = workflow.read_text()
s = s.replace(
    '  ANDROID_DEBUG_KEYSTORE_BASE64: ${{ secrets.ANDROID_DEBUG_KEYSTORE_BASE64 }}\n',
    '  ANDROID_DEBUG_KEYSTORE_BASE64: ${{ secrets.ANDROID_DEBUG_KEYSTORE_BASE64 }}\n  FIREBASE_GOOGLE_SERVICES_JSON_BASE64: ${{ secrets.FIREBASE_GOOGLE_SERVICES_JSON_BASE64 }}\n',
    1,
)
restore_key = '''      - name: Build debug APK
        working-directory: android-app
'''
firebase_steps = '''      - name: Restore Firebase Android config
        if: env.FIREBASE_GOOGLE_SERVICES_JSON_BASE64 != ''
        shell: bash
        run: |
          printf '%s' "$FIREBASE_GOOGLE_SERVICES_JSON_BASE64" | base64 --decode > android-app/app/google-services.json

      - name: Firebase configuration notice
        if: env.FIREBASE_GOOGLE_SERVICES_JSON_BASE64 == ''
        run: echo "::notice::FCM is not embedded in this APK yet. Add FIREBASE_GOOGLE_SERVICES_JSON_BASE64 under repository Actions secrets, then rerun this workflow."

''' + restore_key
if restore_key not in s:
    raise SystemExit("Android workflow build marker not found")
workflow.write_text(s.replace(restore_key, firebase_steps, 1))

# Documentation.
readme = Path("android-app/README.md")
s = readme.read_text()
s = s.replace(
    '''The foreground `AlertService` maintains a WebSocket connection to the configured HTTPS server. For the normal Cloudflare setup, configure:
''',
    '''The server supports two mutually exclusive phone transports: WebSocket and Firebase Cloud Messaging (FCM). The server-side `alerts.transport` value is authoritative. In WebSocket mode the foreground `AlertService` maintains the connection; in FCM mode the app stops that service and receives high-priority data messages through `FirebaseMessagingService`.

For either mode, configure the server connection used by the dashboard, transport sync, and FCM-token registration:
''',
    1,
)
old_fcm = '''## FCM later

Alert handling is centralized in `AlertNotifier.alert(...)`; a future `FirebaseMessagingService` can call that same path. The current WebSocket connection remains the active transport.
'''
new_fcm = '''## Firebase Cloud Messaging

FCM uses the same `AlertNotifier.alert(...)` path as WebSocket alerts. The phone registration token is POSTed to `/api/fcm/register` and stored locally on the laptop under gitignored `data/fcm-device-token.txt`; it is not tracked in `config.json`.

Firebase configuration files are intentionally untracked:

- `android-app/app/google-services.json` — Android Firebase project configuration.
- `config/fcm-service-account.json` — server credential used to call the FCM HTTP v1 API.

GitHub Actions can embed `google-services.json` by restoring the repository secret `FIREBASE_GOOGLE_SERVICES_JSON_BASE64`. If that secret is absent, the APK still builds and WebSocket mode continues to work, but FCM initialization is unavailable in that APK.
'''
if old_fcm not in s:
    raise SystemExit("README FCM marker not found")
readme.write_text(s.replace(old_fcm, new_fcm, 1))

agents = Path("AGENTS.md")
s = agents.read_text()
s = s.replace(
    '  alerts.mjs        Phone-alert transports: "websocket" (POST to GUI hub /api/alerts) or\n                    "fcm" (Firebase direct, hand-rolled service-account OAuth — configured\n                    but never used yet).\n',
    '  alerts.mjs        Mutually exclusive phone-alert transports: "websocket" (POST to GUI hub\n                    /api/alerts) or "fcm" (Firebase HTTP v1, hand-rolled service-account OAuth).\n                    FCM registration token lives in gitignored data/fcm-device-token.txt.\n',
    1,
)
s = s.replace(
    '- FCM is the planned endgame alert transport (battery-proof); server side is\n  written, Firebase project doesn\'t exist yet, app seam is AlertNotifier.alert().\n',
    '- FCM and WebSocket are both implemented; exactly one server transport is active.\n  In FCM mode the Android app stops its foreground WebSocket service after syncing\n  `/api/runtime/config`; both transports feed the same AlertNotifier path.\n',
    1,
)
agents.write_text(s)
