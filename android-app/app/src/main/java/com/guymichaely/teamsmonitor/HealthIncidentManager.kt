package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.time.Instant
import java.util.concurrent.TimeUnit

object HealthIncidentManager {
    const val POLICY_NOTIFY = "notify"
    const val POLICY_ALARM_NOW = "alarm_now"
    const val POLICY_ALARM_AFTER_DELAY = "alarm_after_delay"
    const val POLICY_IGNORE = "ignore"

    fun handleHeartbeat(context: Context, status: String, at: String? = null, source: String = "unknown") {
        val app = context.applicationContext
        when (status.lowercase()) {
            "missing" -> onMissing(app, at, source)
            "recovered", "current" -> onRecovered(app, source)
            else -> AppLog.event(app, "heartbeat_incident_ignored", "status=$status source=$source")
        }
    }

    private fun onMissing(context: Context, at: String?, source: String) {
        val prefs = Prefs(context)
        if (prefs.heartbeatIncidentActive) {
            AppLog.event(context, "heartbeat_incident_duplicate", "source=$source")
            return
        }

        prefs.heartbeatIncidentActive = true
        prefs.heartbeatIncidentAtMs = runCatching { Instant.parse(at).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
        val policy = prefs.heartbeatPolicy
        AppLog.event(context, "heartbeat_missing", "source=$source policy=$policy")

        when (policy) {
            POLICY_IGNORE -> Unit
            POLICY_ALARM_NOW -> {
                showNotification(context, prefs)
                playAlarm(context, prefs)
            }
            POLICY_ALARM_AFTER_DELAY -> {
                showNotification(context, prefs)
                scheduleDelayedAlarm(context, prefs.heartbeatDelayMinutes)
            }
            else -> showNotification(context, prefs)
        }
    }

    private fun onRecovered(context: Context, source: String) {
        val prefs = Prefs(context)
        val wasActive = prefs.heartbeatIncidentActive
        prefs.heartbeatIncidentActive = false
        prefs.heartbeatIncidentAtMs = 0L
        WorkManager.getInstance(context).cancelUniqueWork(DELAYED_WORK_NAME)
        if (wasActive) {
            AlertNotifier.stopAlarm("heartbeat_recovered")
            AppLog.event(context, "heartbeat_recovered", "source=$source")
        }
    }

    private fun showNotification(context: Context, prefs: Prefs) {
        if (!prefs.notifEnabled) {
            AppLog.event(context, "heartbeat_notification_suppressed", "reason=app_setting")
            return
        }
        AlertNotifier.show(
            context,
            chat = "Teams Monitor",
            author = "Watchdog",
            text = "PC/orchestrator heartbeat is missing"
        )
    }

    private fun playAlarm(context: Context, prefs: Prefs) {
        if (!prefs.alarmEnabled) {
            AppLog.event(context, "heartbeat_alarm_suppressed", "reason=app_setting")
            return
        }
        AlertNotifier.playAlarm(
            context,
            volume = prefs.alarmVolume / 100f,
            durationMs = prefs.alarmDurationSec * 1000L
        )
    }

    private fun scheduleDelayedAlarm(context: Context, delayMinutes: Int) {
        val work = OneTimeWorkRequestBuilder<HeartbeatAlarmWorker>()
            .setInitialDelay(delayMinutes.toLong(), TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            DELAYED_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            work
        )
        AppLog.event(context, "heartbeat_alarm_scheduled", "delayMinutes=$delayMinutes")
    }

    fun fireDelayedAlarm(context: Context): Boolean {
        val prefs = Prefs(context)
        if (!prefs.heartbeatIncidentActive || prefs.heartbeatPolicy != POLICY_ALARM_AFTER_DELAY) {
            AppLog.event(context, "heartbeat_delayed_alarm_cancelled", "reason=incident_inactive_or_policy_changed")
            return false
        }
        AppLog.event(context, "heartbeat_delayed_alarm_firing")
        playAlarm(context, prefs)
        return true
    }

    private const val DELAYED_WORK_NAME = "heartbeat-delayed-alarm"
}
