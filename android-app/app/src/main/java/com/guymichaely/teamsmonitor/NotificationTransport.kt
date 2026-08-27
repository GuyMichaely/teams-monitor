package com.guymichaely.teamsmonitor

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

        // Register opportunistically even while WebSocket is active. This lets the
        // server confirm the phone token before the user switches transport to FCM.
        FcmRegistration.syncCurrentToken(app)

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
        } else {
            AlertService.start(context)
        }
    }
}
