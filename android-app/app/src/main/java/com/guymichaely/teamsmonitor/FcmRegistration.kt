package com.guymichaely.teamsmonitor

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
