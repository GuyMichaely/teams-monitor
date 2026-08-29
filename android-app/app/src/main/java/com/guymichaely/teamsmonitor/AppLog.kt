package com.guymichaely.teamsmonitor

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import java.io.File
import java.time.Instant

/** Small rolling log kept in app-private storage for postmortem debugging. */
object AppLog {
    private const val TAG = "TeamsMonitor"
    private const val FILE_NAME = "diagnostics.log"
    private const val MAX_CHARS = 1_000_000
    private const val KEEP_CHARS = 750_000
    private val lock = Any()

    fun event(context: Context, name: String, details: String = "") {
        val safeDetails = redact(details).replace('\n', ' ').take(2_000)
        val line = buildString {
            append(Instant.now())
            append(" | ")
            append(name)
            if (safeDetails.isNotBlank()) {
                append(" | ")
                append(safeDetails)
            }
        }
        Log.i(TAG, line)
        synchronized(lock) {
            val file = File(context.applicationContext.filesDir, FILE_NAME)
            if (file.exists() && file.length() > MAX_CHARS) trim(file)
            file.appendText(line + "\n")
        }
    }

    @Suppress("DEPRECATION")
    fun report(context: Context): String {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val pm = app.getSystemService(PowerManager::class.java)
        val nm = app.getSystemService(NotificationManager::class.java)
        val packageInfo = app.packageManager.getPackageInfo(app.packageName, 0)
        val versionCode = if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else packageInfo.versionCode.toLong()
        val notificationsPermission = Build.VERSION.SDK_INT < 33 ||
            app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

        val header = buildString {
            appendLine("Teams Monitor diagnostics")
            appendLine("generated=${Instant.now()}")
            appendLine("appVersion=${packageInfo.versionName} ($versionCode)")
            appendLine("android=${Build.VERSION.RELEASE} sdk=${Build.VERSION.SDK_INT}")
            appendLine("device=${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("connection=${AlertState.connection}")
            appendLine("server=${prefs.serverUrl.ifBlank { "(not set)" }}")
            appendLine("tokenConfigured=${prefs.token.isNotBlank()}")
            appendLine("preferredTransport=${prefs.alertTransport}")
            appendLine("websocketRecoveryRequested=${prefs.websocketRecoveryRequested}")
            appendLine("fcmFidPresent=${prefs.fcmFid.isNotBlank()}")
            appendLine("fcmFidLength=${prefs.fcmFid.length}")
            appendLine("fcmSyncPending=${prefs.fcmSyncPending}")
            appendLine("fcmRegistrationUpdatedAt=${instantOrNever(prefs.fcmRegistrationUpdatedAtMs)}")
            appendLine("controlWorkerEnabled=${prefs.controlWorkerEnabled}")
            appendLine("controlWorkerConfigured=${prefs.controlWorkerUrl.isNotBlank()}")
            appendLine("lastControlSyncAt=${instantOrNever(prefs.lastControlSyncAtMs)}")
            appendLine("healthIncidentPolicy=${prefs.heartbeatPolicy}")
            appendLine("healthIncidentDelayMinutes=${prefs.heartbeatDelayMinutes}")
            appendLine("heartbeatIncidentActive=${prefs.heartbeatIncidentActive}")
            appendLine("heartbeatIncidentAt=${instantOrNever(prefs.heartbeatIncidentAtMs)}")
            appendLine("tunnelIncidentActive=${prefs.tunnelIncidentActive}")
            appendLine("tunnelIncidentAt=${instantOrNever(prefs.tunnelIncidentAtMs)}")
            appendLine("network=${networkSummary(app)}")
            appendLine("batteryOptimizationIgnored=${pm?.isIgnoringBatteryOptimizations(app.packageName) == true}")
            appendLine("notificationPermission=$notificationsPermission")
            appendLine("notificationsEnabled=${NotificationManagerCompat.from(app).areNotificationsEnabled()}")
            appendLine("dndAccess=${nm?.isNotificationPolicyAccessGranted == true}")
            appendLine("alarmEnabled=${prefs.alarmEnabled}")
            appendLine("notifEnabled=${prefs.notifEnabled}")
            appendLine("alarmWhenScreenOn=${prefs.alarmWhenScreenOn}")
            appendLine("--- recent log ---")
        }
        return header + read(app)
    }

    fun networkSummary(context: Context): String {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return "unknown"
        val network = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(network) ?: return "unknown"
        val transports = buildList {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) add("wifi")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) add("cellular")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) add("ethernet")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) add("vpn")
        }
        return "${transports.ifEmpty { listOf("other") }.joinToString("+")}," +
            "validated=${caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)}"
    }

    private fun instantOrNever(valueMs: Long): String =
        if (valueMs > 0L) Instant.ofEpochMilli(valueMs).toString() else "never"

    private fun read(context: Context): String = synchronized(lock) {
        val file = File(context.applicationContext.filesDir, FILE_NAME)
        if (file.exists()) file.readText() else "(no diagnostic events yet)\n"
    }

    private fun trim(file: File) {
        val text = file.readText()
        val tail = text.takeLast(KEEP_CHARS)
        val firstNewline = tail.indexOf('\n')
        file.writeText(if (firstNewline >= 0) tail.substring(firstNewline + 1) else tail)
    }

    private fun redact(value: String): String = value
        .replace(Regex("(?i)(access_token=)[^&\\s]+"), "$1<redacted>")
        .replace(Regex("(?i)(authorization:\\s*bearer\\s+)[^\\s]+"), "$1<redacted>")
}
