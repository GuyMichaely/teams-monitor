package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

object NotificationTransport {
    private val client = OkHttpClient()
    private val jsonType = "application/json".toMediaType()

    fun sync(context: Context) {
        val app = context.applicationContext
        schedulePeriodic(app)
        val prefs = Prefs(app)
        if (prefs.serverUrl.isBlank()) {
            syncWorkerAsync(app, prefs)
            return
        }

        client.newCall(directRequest(prefs)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.event(app, "control_sync_failed", "path=direct error=${e.javaClass.simpleName}:${e.message ?: ""}")
                syncWorkerAsync(app, prefs)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        AppLog.event(app, "control_sync_failed", "path=direct http=${it.code}")
                        syncWorkerAsync(app, prefs)
                        return
                    }
                    val body = runCatching { JSONObject(it.body?.string().orEmpty()) }.getOrNull()
                    if (body == null) {
                        AppLog.event(app, "control_sync_failed", "path=direct reason=invalid_json")
                        syncWorkerAsync(app, prefs)
                        return
                    }
                    applyControlResponse(app, body, "direct")
                    // applyControlResponse may have just taught the phone the Worker
                    // URL. Mirror to it even though the direct path succeeded.
                    mirrorWorkerAsync(app, Prefs(app))
                }
            }
        })
    }

    /** Blocking form for WorkManager. Direct path first, Worker fallback second. */
    fun syncBlocking(context: Context): Boolean {
        val app = context.applicationContext
        val initial = Prefs(app)
        if (initial.serverUrl.isNotBlank()) {
            try {
                client.newCall(directRequest(initial)).execute().use { response ->
                    if (response.isSuccessful) {
                        val body = JSONObject(response.body?.string().orEmpty())
                        applyControlResponse(app, body, "worker-direct")
                        mirrorWorkerBlocking(app, Prefs(app))
                        return true
                    }
                    AppLog.event(app, "control_sync_failed", "path=worker-direct http=${response.code}")
                }
            } catch (e: Exception) {
                AppLog.event(app, "control_sync_failed", "path=worker-direct error=${e.javaClass.simpleName}:${e.message ?: ""}")
            }
        }

        val prefs = Prefs(app)
        if (!prefs.controlWorkerEnabled || prefs.controlWorkerUrl.isBlank()) return false
        return try {
            client.newCall(workerRequest(prefs)).execute().use { response ->
                if (!response.isSuccessful) {
                    AppLog.event(app, "control_sync_failed", "path=worker http=${response.code}")
                    false
                } else {
                    val body = JSONObject(response.body?.string().orEmpty())
                    applyControlResponse(app, body, "worker")
                    true
                }
            }
        } catch (e: Exception) {
            AppLog.event(app, "control_sync_failed", "path=worker error=${e.javaClass.simpleName}:${e.message ?: ""}")
            false
        }
    }

    fun schedulePeriodic(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val work = PeriodicWorkRequestBuilder<ControlSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            PERIODIC_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            work
        )
    }

    /** Worker is the fallback source of control state when direct sync failed. */
    private fun syncWorkerAsync(context: Context, prefs: Prefs) {
        if (!prefs.controlWorkerEnabled || prefs.controlWorkerUrl.isBlank()) {
            RecoveryControl.applyWebSocketPolicy(context)
            return
        }
        client.newCall(workerRequest(prefs)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.event(context, "control_sync_failed", "path=worker error=${e.javaClass.simpleName}:${e.message ?: ""}")
                RecoveryControl.applyWebSocketPolicy(context)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        AppLog.event(context, "control_sync_failed", "path=worker http=${it.code}")
                        RecoveryControl.applyWebSocketPolicy(context)
                        return
                    }
                    val body = runCatching { JSONObject(it.body?.string().orEmpty()) }.getOrNull()
                    if (body != null) applyControlResponse(context, body, "worker")
                }
            }
        })
    }

    /** Direct sync already won; this request only keeps shadow/health state current. */
    private fun mirrorWorkerAsync(context: Context, prefs: Prefs) {
        if (!prefs.controlWorkerEnabled || prefs.controlWorkerUrl.isBlank()) return
        client.newCall(workerRequest(prefs)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.event(context, "control_worker_mirror_failed", "error=${e.javaClass.simpleName}:${e.message ?: ""}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val bodyText = it.body?.string().orEmpty()
                    AppLog.event(
                        context,
                        if (it.isSuccessful) "control_worker_mirror_ok" else "control_worker_mirror_failed",
                        "http=${it.code}"
                    )
                    if (it.isSuccessful) {
                        runCatching { JSONObject(bodyText) }.getOrNull()?.let { body ->
                            applyHeartbeatIncident(context, body, "worker-mirror")
                        }
                    }
                }
            }
        })
    }

    private fun mirrorWorkerBlocking(context: Context, prefs: Prefs) {
        if (!prefs.controlWorkerEnabled || prefs.controlWorkerUrl.isBlank()) return
        runCatching {
            client.newCall(workerRequest(prefs)).execute().use { response ->
                val bodyText = response.body?.string().orEmpty()
                AppLog.event(
                    context,
                    if (response.isSuccessful) "control_worker_mirror_ok" else "control_worker_mirror_failed",
                    "http=${response.code}"
                )
                if (response.isSuccessful) {
                    runCatching { JSONObject(bodyText) }.getOrNull()?.let { body ->
                        applyHeartbeatIncident(context, body, "worker-mirror")
                    }
                }
            }
        }.onFailure {
            AppLog.event(context, "control_worker_mirror_failed", "error=${it.javaClass.simpleName}:${it.message ?: ""}")
        }
    }

    private fun directRequest(prefs: Prefs): Request {
        return Request.Builder()
            .url(prefs.serverUrl.trimEnd('/') + "/api/control/sync")
            .post(phoneState(prefs).toString().toRequestBody(jsonType))
            .apply { if (prefs.token.isNotBlank()) header("Authorization", "Bearer ${prefs.token}") }
            .build()
    }

    private fun workerRequest(prefs: Prefs): Request {
        return Request.Builder()
            .url(prefs.controlWorkerUrl.trimEnd('/') + "/api/phone/sync")
            .post(phoneState(prefs).toString().toRequestBody(jsonType))
            .apply { if (prefs.token.isNotBlank()) header("Authorization", "Bearer ${prefs.token}") }
            .build()
    }

    private fun phoneState(prefs: Prefs): JSONObject = JSONObject()
        .put("at", Instant.now().toString())
        .put("fid", prefs.fcmFid)
        .put(
            "registrationUpdatedAt",
            if (prefs.fcmRegistrationUpdatedAtMs > 0)
                Instant.ofEpochMilli(prefs.fcmRegistrationUpdatedAtMs).toString()
            else JSONObject.NULL
        )
        .put("websocketState", AlertState.connection.name.lowercase())

    private fun applyControlResponse(context: Context, raw: JSONObject, source: String) {
        applyHeartbeatIncident(context, raw, source)

        // Direct server responses expose state at the root. Worker responses
        // return the latest PC sync under pc.state.
        val state = raw.optJSONObject("pc")?.optJSONObject("state") ?: raw
        val primary = state.optString("primaryTransport", Prefs(context).alertTransport)
        val websocketWanted = if (state.has("websocketWanted")) {
            state.optBoolean("websocketWanted")
        } else {
            primary == "websocket"
        }
        val fcmStatus = state.optJSONObject("fcm")?.let { fcm ->
            if (fcm.has("registrationStatus")) fcm.optString("registrationStatus") else null
        }
        val worker = state.optJSONObject("controlWorker")
        val workerEnabled = worker?.optBoolean("enabled")
        val workerUrl = worker?.optString("url")

        RecoveryControl.applyServerState(
            context,
            primaryTransport = primary,
            websocketWanted = websocketWanted,
            fcmRegistrationStatus = fcmStatus,
            workerEnabled = workerEnabled,
            workerUrl = workerUrl
        )
        AppLog.event(
            context,
            "control_synced",
            "source=$source primary=$primary websocketWanted=$websocketWanted fcmRegistration=${fcmStatus ?: "unknown"}"
        )
    }

    private fun applyHeartbeatIncident(context: Context, raw: JSONObject, source: String) {
        val heartbeat = raw.optJSONObject("incidents")?.optJSONObject("heartbeat") ?: return
        val status = heartbeat.optString("status", "")
        if (status.isBlank()) return
        HealthIncidentManager.handleHeartbeat(
            context,
            status = status,
            at = if (heartbeat.has("at")) heartbeat.optString("at") else null,
            source = source
        )
    }

    private const val PERIODIC_WORK_NAME = "control-state-sync"
}
