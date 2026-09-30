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
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
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
        try {
            synchronized(lock) {
                val file = File(context.applicationContext.filesDir, FILE_NAME)
                if (file.exists() && file.length() > MAX_CHARS) trim(file)
                file.appendText(line + "\n")
            }
        } catch (_: Exception) {
            // Storage failure must not prevent an incoming alert from being handled.
            Log.w(TAG, "Unable to persist diagnostics entry")
        }
    }

    /** Rewrites only diagnostics.log; the lock prevents append/delete races. */
    fun deleteBefore(context: Context, cutoff: Instant): DiagnosticsDeletion.Result = synchronized(lock) {
        val file = File(context.applicationContext.filesDir, FILE_NAME)
        val result = DiagnosticsDeletion.before(if (file.exists()) file.readText() else "", cutoff)
        if (!file.exists() || result.deletedCount == 0) return@synchronized result
        val temp = File(file.parentFile, "$FILE_NAME.cleanup-${System.nanoTime()}.tmp")
        try {
            FileOutputStream(temp).use { stream ->
                val retained = result.retainedLines.joinToString("\n", postfix = if (result.retainedLines.isEmpty()) "" else "\n")
                stream.write(retained.toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            if (temp.exists()) temp.delete()
        }
        result
    }

    fun previewDeleteBefore(context: Context, cutoff: Instant): DiagnosticsDeletion.Result = synchronized(lock) {
        val file = File(context.applicationContext.filesDir, FILE_NAME)
        DiagnosticsDeletion.before(if (file.exists()) file.readText() else "", cutoff)
    }

    @Suppress("DEPRECATION")
    fun report(context: Context, filter: DiagnosticsFilter = DiagnosticsFilter()): String {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val pm = app.getSystemService(PowerManager::class.java)
        val nm = app.getSystemService(NotificationManager::class.java)
        val packageInfo = app.packageManager.getPackageInfo(app.packageName, 0)
        val versionCode = if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else packageInfo.versionCode.toLong()
        val notificationsPermission = Build.VERSION.SDK_INT < 33 ||
            app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

        val now = Instant.now()
        val selected = filter.select(read(app), now)
        val header = buildString {
            appendLine("TM diagnostics")
            appendLine("generated=$now")
            appendLine("logWindow=${if (filter.rangeStartMs != null) "custom range" else filter.windowMs?.let { "${it / 60_000} minutes" } ?: "all retained"}")
            appendLine("selectionTimeZone=${filter.localZoneId}")
            if (filter.rangeStartMs != null && filter.rangeEndMs != null) {
                appendLine("logFromUtc=${Instant.ofEpochMilli(filter.rangeStartMs)}")
                appendLine("logToUtc=${Instant.ofEpochMilli(filter.rangeEndMs)} (inclusive)")
            }
            appendLine("logCategory=${filter.category}")
            appendLine("logSearch=${redact(filter.query).replace('\n', ' ')}")
            appendLine("logExported=${selected.lines.size} matched=${selected.matchedCount} retained=${selected.retainedCount}")
            appendLine("logOmittedByExportLimit=${selected.omittedCount} unparseableTimestamps=${selected.unparseableCount}")
            appendLine("Log is rolling, not a complete history. Export keeps newest matching entries up to 200000 characters.")
            appendLine("Timestamps are UTC. State below is current, not historical. Review chat/author names before sharing.")
            appendLine("appVersion=${packageInfo.versionName} ($versionCode)")
            appendLine("android=${Build.VERSION.RELEASE} sdk=${Build.VERSION.SDK_INT}")
            appendLine("device=${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("connection=${AlertState.connection}")
            appendLine("server=${redact(prefs.serverUrl).ifBlank { "(not set)" }}")
            appendLine("tokenConfigured=${prefs.token.isNotBlank()}")
            appendLine("preferredTransport=${prefs.alertTransport}")
            appendLine("fallbackTransport=${prefs.fallbackTransport}")
            appendLine("fcmRegistrationStatus=${prefs.fcmRegistrationStatus}")
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
        val report = header + if (selected.lines.isEmpty()) "(no events match these filters)\n"
            else selected.lines.joinToString("\n", postfix = "\n")
        return DiagnosticsRedaction.redact(report, prefs.token)
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

    fun receiptDeviceState(context: Context): String = runCatching {
        val app = context.applicationContext
        val pm = app.getSystemService(PowerManager::class.java)
        val interactive = pm?.isInteractive == true
        val idle = if (Build.VERSION.SDK_INT >= 23) pm?.isDeviceIdleMode == true else false
        val powerSave = pm?.isPowerSaveMode == true
        val exempt = pm?.isIgnoringBatteryOptimizations(app.packageName) == true
        "network=${networkSummary(app)},screenOn=$interactive,deviceIdle=$idle,powerSave=$powerSave,batteryOptimizationExempt=$exempt"
    }.getOrDefault("unavailable")

    private fun instantOrNever(valueMs: Long): String =
        if (valueMs > 0L) Instant.ofEpochMilli(valueMs).toString() else "never"

    private fun read(context: Context): String = synchronized(lock) {
        val file = File(context.applicationContext.filesDir, FILE_NAME)
        if (file.exists()) file.readText() else ""
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
