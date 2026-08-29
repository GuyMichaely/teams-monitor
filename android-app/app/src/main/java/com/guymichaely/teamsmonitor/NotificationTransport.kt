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
            RecoveryControl.applyWebSocketPolicy(app)
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
                }
            }
        })
    }

    /** Blocking form for WorkManager. Direct path first, Worker fallback second. */
    fun syncBlocking(context: Context): Boolean {
        val app = context.applicationContext
        val prefs = Prefs(app)
        if (prefs.serverUrl.isNotBlank()) {
            try {
                client.newCall(directRequest(prefs)).execute().use { response ->
                    if (response.isSuccessful) {
                        val body = JSONObject(response.body?.string().orEmpty())
                        applyControlResponse(app, body, "worker-direct")
                        return true
                    }
                    AppLog.event(app, "control_sync_failed", "path=worker-direct http=${response.code}")
                }
            } catch (e: Exception) {
                AppLog.event(app, "control_sync_failed", "path=worker-direct error=${e.javaClass.simpleName}:${e.message ?: ""}")
            }
        }

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
        // Direct server responses expose state at the root. Worker responses
        // return the latest PC sync under pc.state.
        val state = raw.optJSONObject("pc")?.optJSONObject("state") ?: raw
        val primary = state.optString("primaryTransport", Prefs(context).alertTransport)
        val websocketWanted = if (state.has("websocketWanted")) {
            state.optBoolean("websocketWanted")
        } else {
            primary == "websocket"
        }
        val fcmStatus = state.optJSONObject("fcm")?.optString("registrationStatus", null)
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

    private const val PERIODIC_WORK_NAME = "control-state-sync"
}
