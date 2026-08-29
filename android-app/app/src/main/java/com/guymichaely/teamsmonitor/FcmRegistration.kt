package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
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
import java.time.Instant
import java.util.concurrent.TimeUnit

object FcmRegistration {
    private val client = OkHttpClient()
    private val jsonType = "application/json".toMediaType()

    /** Called by Firebase whenever this installation is confirmed registered with FCM. */
    fun onRegistered(context: Context, fid: String) {
        val app = context.applicationContext
        val value = fid.trim()
        if (value.isBlank()) return
        val prefs = Prefs(app)
        prefs.fcmFid = value
        prefs.fcmRegistrationUpdatedAtMs = System.currentTimeMillis()
        prefs.fcmSyncPending = true
        AppLog.event(app, "fcm_registered_fid", "fidLength=${value.length}")
        syncStoredAsync(app)
    }

    /** Recovery action: ask Firebase to ensure this installation is registered now. */
    fun ensureRegistered(context: Context, reason: String) {
        val app = context.applicationContext
        if (FirebaseApp.getApps(app).isEmpty()) {
            AppLog.event(app, "fcm_unavailable", "reason=google_services_not_configured")
            return
        }
        AppLog.event(app, "fcm_registration_requested", "reason=$reason")
        FirebaseMessaging.getInstance().register().addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                AppLog.event(
                    app,
                    "fcm_registration_failed",
                    "reason=$reason error=${task.exception?.message ?: "unknown"}"
                )
                enqueueRetry(app)
            } else {
                // onRegistered(fid) is delivered asynchronously by Firebase.
                AppLog.event(app, "fcm_registration_request_ok", "reason=$reason")
            }
        }
    }

    fun syncStoredAsync(context: Context) {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val fid = prefs.fcmFid
        if (fid.isBlank()) return
        if (prefs.serverUrl.isBlank()) {
            prefs.fcmSyncPending = true
            AppLog.event(app, "fcm_sync_deferred", "reason=server_not_configured")
            enqueueRetry(app)
            return
        }

        val request = directRequest(prefs, fid)
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                prefs.fcmSyncPending = true
                AppLog.event(app, "fcm_sync_failed", "path=direct error=${e.javaClass.simpleName}:${e.message ?: ""}")
                mirrorToWorkerAsync(app, prefs, fid)
                enqueueRetry(app)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (it.isSuccessful) {
                        prefs.fcmSyncPending = false
                        AppLog.event(app, "fcm_sync_ok", "path=direct http=${it.code} fidLength=${fid.length}")
                        WorkManager.getInstance(app).cancelUniqueWork(WORK_NAME)
                    } else {
                        prefs.fcmSyncPending = true
                        AppLog.event(app, "fcm_sync_failed", "path=direct http=${it.code}")
                        mirrorToWorkerAsync(app, prefs, fid)
                        enqueueRetry(app)
                    }
                }
            }
        })
    }

    /** Blocking version used only by WorkManager. */
    fun syncStoredBlocking(context: Context): Boolean {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val fid = prefs.fcmFid
        if (fid.isBlank() || prefs.serverUrl.isBlank()) return false

        return try {
            client.newCall(directRequest(prefs, fid)).execute().use { response ->
                if (response.isSuccessful) {
                    prefs.fcmSyncPending = false
                    AppLog.event(app, "fcm_sync_ok", "path=worker-direct http=${response.code} fidLength=${fid.length}")
                    true
                } else {
                    prefs.fcmSyncPending = true
                    AppLog.event(app, "fcm_sync_failed", "path=worker-direct http=${response.code}")
                    mirrorToWorkerBlocking(app, prefs, fid)
                    false
                }
            }
        } catch (e: Exception) {
            prefs.fcmSyncPending = true
            AppLog.event(app, "fcm_sync_failed", "path=worker-direct error=${e.javaClass.simpleName}:${e.message ?: ""}")
            mirrorToWorkerBlocking(app, prefs, fid)
            false
        }
    }

    private fun directRequest(prefs: Prefs, fid: String): Request {
        val body = registrationBody(prefs, fid).toString().toRequestBody(jsonType)
        return Request.Builder()
            .url(prefs.serverUrl.trimEnd('/') + "/api/fcm/register")
            .post(body)
            .apply { if (prefs.token.isNotBlank()) header("Authorization", "Bearer ${prefs.token}") }
            .build()
    }

    private fun registrationBody(prefs: Prefs, fid: String): JSONObject =
        JSONObject()
            .put("fid", fid)
            .put(
                "observedAt",
                if (prefs.fcmRegistrationUpdatedAtMs > 0)
                    Instant.ofEpochMilli(prefs.fcmRegistrationUpdatedAtMs).toString()
                else Instant.now().toString()
            )

    private fun mirrorToWorkerAsync(context: Context, prefs: Prefs, fid: String) {
        if (!prefs.controlWorkerEnabled || prefs.controlWorkerUrl.isBlank()) return
        val request = workerRequest(prefs, fid)
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.event(context, "fcm_worker_mirror_failed", "error=${e.javaClass.simpleName}:${e.message ?: ""}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    AppLog.event(
                        context,
                        if (it.isSuccessful) "fcm_worker_mirror_ok" else "fcm_worker_mirror_failed",
                        "http=${it.code}"
                    )
                }
            }
        })
    }

    private fun mirrorToWorkerBlocking(context: Context, prefs: Prefs, fid: String) {
        if (!prefs.controlWorkerEnabled || prefs.controlWorkerUrl.isBlank()) return
        runCatching {
            client.newCall(workerRequest(prefs, fid)).execute().use { response ->
                AppLog.event(
                    context,
                    if (response.isSuccessful) "fcm_worker_mirror_ok" else "fcm_worker_mirror_failed",
                    "http=${response.code}"
                )
            }
        }.onFailure {
            AppLog.event(context, "fcm_worker_mirror_failed", "error=${it.javaClass.simpleName}:${it.message ?: ""}")
        }
    }

    private fun workerRequest(prefs: Prefs, fid: String): Request {
        val body = JSONObject()
            .put("at", Instant.now().toString())
            .put("fid", fid)
            .put(
                "registrationUpdatedAt",
                if (prefs.fcmRegistrationUpdatedAtMs > 0)
                    Instant.ofEpochMilli(prefs.fcmRegistrationUpdatedAtMs).toString()
                else Instant.now().toString()
            )
            .toString()
            .toRequestBody(jsonType)
        return Request.Builder()
            .url(prefs.controlWorkerUrl.trimEnd('/') + "/api/phone/sync")
            .post(body)
            .apply { if (prefs.token.isNotBlank()) header("Authorization", "Bearer ${prefs.token}") }
            .build()
    }

    fun enqueueRetry(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val work = OneTimeWorkRequestBuilder<FcmRegistrationWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, work)
    }

    private const val WORK_NAME = "fcm-registration-sync"
}
