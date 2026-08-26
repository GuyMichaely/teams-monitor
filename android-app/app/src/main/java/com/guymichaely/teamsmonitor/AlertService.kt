package com.guymichaely.teamsmonitor

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Holds the alert-hub WebSocket open; reconnects with exponential backoff. */
class AlertService : Service() {

    private lateinit var prefs: Prefs
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
    private lateinit var executor: ScheduledExecutorService
    @Volatile private var webSocket: WebSocket? = null
    private var retries = 0
    @Volatile private var stopped = false

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        executor = Executors.newSingleThreadScheduledExecutor()
        AlertNotifier.createChannels(this)
        AppLog.event(
            this,
            "service_create",
            "server=${prefs.serverUrl.ifBlank { "(not set)" }} tokenConfigured=${prefs.token.isNotBlank()} network=${AppLog.networkSummary(this)}"
        )
        ServiceCompat.startForeground(
            this,
            AlertNotifier.SERVICE_NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        )
        ContextCompat.registerReceiver(
            this, screenOnReceiver, IntentFilter(Intent.ACTION_SCREEN_ON),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        executor.scheduleAtFixedRate(
            {
                AppLog.event(
                    this,
                    "service_heartbeat",
                    "connection=${AlertState.connection} network=${AppLog.networkSummary(this)}"
                )
            },
            HEARTBEAT_MINUTES,
            HEARTBEAT_MINUTES,
            TimeUnit.MINUTES
        )
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AppLog.event(
            this,
            "service_start_command",
            "action=${intent?.action ?: "(none)"} startId=$startId flags=$flags"
        )
        if (intent?.action == ACTION_RECONNECT) {
            retries = 0
            AppLog.event(this, "ws_manual_reconnect")
            // clear the field first so the cancelled socket's failure callback is ignored
            val old = webSocket
            webSocket = null
            old?.cancel()
            connect()
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        AppLog.event(this, "service_task_removed")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        AppLog.event(this, "service_destroy")
        stopped = true
        unregisterReceiver(screenOnReceiver)
        webSocket?.cancel()
        executor.shutdownNow()
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun connect() {
        if (stopped) {
            AppLog.event(this, "ws_connect_skipped", "reason=service_stopped")
            return
        }
        if (webSocket != null) {
            AppLog.event(this, "ws_connect_skipped", "reason=socket_exists")
            return
        }
        if (prefs.serverUrl.isBlank()) {
            AppLog.event(this, "ws_connect_skipped", "reason=server_not_configured")
            return
        }
        AlertState.onConnection(this, AlertState.Connection.CONNECTING)
        AppLog.event(
            this,
            "ws_connecting",
            "server=${prefs.serverUrl} tokenConfigured=${prefs.token.isNotBlank()} network=${AppLog.networkSummary(this)}"
        )
        val req = Request.Builder().url(wsUrl()).build()
        webSocket = client.newWebSocket(req, listener)
    }

    private fun wsUrl(): String {
        val base = prefs.serverUrl.trimEnd('/')
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> "ws://$base"
        }
        var url = "$wsBase/ws/alerts"
        if (prefs.token.isNotEmpty()) {
            url += "?access_token=" + URLEncoder.encode(prefs.token, "UTF-8")
        }
        return url
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val delay = minOf(1L shl retries.coerceAtMost(6), MAX_BACKOFF_S)
        retries++
        AppLog.event(this, "ws_reconnect_scheduled", "delaySeconds=$delay attempt=$retries")
        executor.schedule({ connect() }, delay, TimeUnit.SECONDS)
    }

    private fun buildNotification(): Notification {
        val tap = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, AlertNotifier.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Listening for alerts")
            .setOngoing(true)
            .setContentIntent(tap)
            .build()
    }

    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            AppLog.event(this@AlertService, "screen_on")
            AlertNotifier.stopAlarm("screen_on")
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            retries = 0
            AlertState.onConnection(this@AlertService, AlertState.Connection.CONNECTED)
            AppLog.event(
                this@AlertService,
                "ws_connected",
                "http=${response.code} protocol=${response.protocol}"
            )
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                JSONObject(text)
            } catch (e: Exception) {
                AppLog.event(
                    this@AlertService,
                    "ws_message_invalid_json",
                    "error=${e.javaClass.simpleName}:${e.message ?: ""} length=${text.length}"
                )
                return
            }
            val kind = msg.optString("kind")
            if (kind != "alert") {
                AppLog.event(this@AlertService, "ws_message_ignored", "kind=$kind length=${text.length}")
                return
            }
            val chat = msg.optString("chat")
            val author = msg.optString("author")
            val alertText = msg.optString("text")
            val alertTime = msg.optString("time")
            AppLog.event(
                this@AlertService,
                "alert_received",
                "chat=$chat author=$author serverTime=$alertTime textLength=${alertText.length}"
            )
            AlertState.onAlert(this@AlertService, chat, author, alertText, alertTime)
            AlertNotifier.alert(this@AlertService, chat, author, alertText)
        }

        /** The current socket died: forget it, then schedule a reconnect. */
        private fun onSocketDead(ws: WebSocket) {
            // ignore callbacks from sockets we already replaced (cancel on reconnect)
            if (ws !== this@AlertService.webSocket) return
            this@AlertService.webSocket = null
            AlertState.onConnection(this@AlertService, AlertState.Connection.DISCONNECTED)
            scheduleReconnect()
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            AppLog.event(this@AlertService, "ws_closing", "code=$code reason=$reason")
            webSocket.close(1000, null)
            onSocketDead(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            AppLog.event(this@AlertService, "ws_closed", "code=$code reason=$reason")
            onSocketDead(webSocket)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            AppLog.event(
                this@AlertService,
                "ws_failure",
                "error=${t.javaClass.simpleName}:${t.message ?: ""} http=${response?.code ?: "none"} network=${AppLog.networkSummary(this@AlertService)}"
            )
            onSocketDead(webSocket)
        }
    }

    companion object {
        private const val MAX_BACKOFF_S = 60L
        private const val HEARTBEAT_MINUTES = 15L
        private const val ACTION_RECONNECT = "com.guymichaely.teamsmonitor.RECONNECT"

        fun start(context: Context) {
            AppLog.event(context, "service_start_requested")
            val i = Intent(context, AlertService::class.java)
            ContextCompat.startForegroundService(context, i)
        }

        /** Drop the current socket and reconnect immediately (settings changed). */
        fun reconnect(context: Context) {
            AppLog.event(context, "service_reconnect_requested")
            val i = Intent(context, AlertService::class.java).setAction(ACTION_RECONNECT)
            ContextCompat.startForegroundService(context, i)
        }
    }
}
