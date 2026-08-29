package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.time.Instant
import java.util.concurrent.TimeUnit

object HealthIncidentManager {
    const val POLICY_NOTIFY = "notify"
    const val POLICY_ALARM_NOW = "alarm_now"
    const val POLICY_ALARM_AFTER_DELAY = "alarm_after_delay"
    const val POLICY_IGNORE = "ignore"

    const val INCIDENT_PC_HEARTBEAT = "pc_heartbeat"
    const val INCIDENT_PUBLIC_TUNNEL = "public_tunnel"

    fun handleHeartbeat(context: Context, status: String, at: String? = null, source: String = "unknown") {
        handleIncident(context, INCIDENT_PC_HEARTBEAT, status, at, source)
    }

    fun handleIncident(
        context: Context,
        incident: String,
        status: String,
        at: String? = null,
        source: String = "unknown"
    ) {
        val app = context.applicationContext
        if (incident != INCIDENT_PC_HEARTBEAT && incident != INCIDENT_PUBLIC_TUNNEL) {
            AppLog.event(app, "health_incident_ignored", "incident=$incident status=$status source=$source")
            return
        }
        when (status.lowercase()) {
            "missing" -> onMissing(app, incident, at, source)
            "recovered", "current" -> onRecovered(app, incident, source)
            else -> AppLog.event(app, "health_incident_ignored", "incident=$incident status=$status source=$source")
        }
    }

    private fun onMissing(context: Context, incident: String, at: String?, source: String) {
        val prefs = Prefs(context)
        if (isActive(prefs, incident)) {
            AppLog.event(context, "health_incident_duplicate", "incident=$incident source=$source")
            return
        }

        val incidentAt = runCatching { Instant.parse(at).toEpochMilli() }
            .getOrDefault(System.currentTimeMillis())
        setIncidentState(prefs, incident, active = true, atMs = incidentAt)
        val policy = prefs.heartbeatPolicy
        AppLog.event(context, "health_missing", "incident=$incident source=$source policy=$policy")

        when (policy) {
            POLICY_IGNORE -> Unit
            POLICY_ALARM_NOW -> {
                showNotification(context, prefs, incident)
                playAlarm(context, prefs, incident)
            }
            POLICY_ALARM_AFTER_DELAY -> {
                showNotification(context, prefs, incident)
                scheduleDelayedAlarm(context, incident, prefs.heartbeatDelayMinutes)
            }
            else -> showNotification(context, prefs, incident)
        }
    }

    private fun onRecovered(context: Context, incident: String, source: String) {
        val prefs = Prefs(context)
        val wasActive = isActive(prefs, incident)
        setIncidentState(prefs, incident, active = false, atMs = 0L)
        WorkManager.getInstance(context).cancelUniqueWork(delayedWorkName(incident))
        if (wasActive) {
            val stoppedWatchdog = AlertNotifier.stopAlarmIfOwner(
                alarmOwner(incident),
                "${incident}_recovered"
            )
            AppLog.event(
                context,
                "health_recovered",
                "incident=$incident source=$source stoppedIncidentAlarm=$stoppedWatchdog"
            )
        }
    }

    private fun showNotification(context: Context, prefs: Prefs, incident: String) {
        if (!prefs.notifEnabled) {
            AppLog.event(context, "health_notification_suppressed", "incident=$incident reason=app_setting")
            return
        }
        AlertNotifier.show(
            context,
            chat = "Teams Monitor",
            author = "Watchdog",
            text = when (incident) {
                INCIDENT_PUBLIC_TUNNEL -> "The public Teams Monitor tunnel is unreachable"
                else -> "PC/orchestrator heartbeat is missing"
            }
        )
    }

    private fun playAlarm(context: Context, prefs: Prefs, incident: String) {
        if (!prefs.alarmEnabled) {
            AppLog.event(context, "health_alarm_suppressed", "incident=$incident reason=app_setting")
            return
        }
        AlertNotifier.playAlarm(
            context,
            volume = prefs.alarmVolume / 100f,
            durationMs = prefs.alarmDurationSec * 1000L,
            owner = alarmOwner(incident)
        )
    }

    private fun scheduleDelayedAlarm(context: Context, incident: String, delayMinutes: Int) {
        val work = OneTimeWorkRequestBuilder<HeartbeatAlarmWorker>()
            .setInitialDelay(delayMinutes.toLong(), TimeUnit.MINUTES)
            .setInputData(workDataOf(KEY_INCIDENT to incident))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            delayedWorkName(incident),
            ExistingWorkPolicy.REPLACE,
            work
        )
        AppLog.event(context, "health_alarm_scheduled", "incident=$incident delayMinutes=$delayMinutes")
    }

    fun fireDelayedAlarm(context: Context, incident: String = INCIDENT_PC_HEARTBEAT): Boolean {
        val prefs = Prefs(context)
        if (!isActive(prefs, incident) || prefs.heartbeatPolicy != POLICY_ALARM_AFTER_DELAY) {
            AppLog.event(
                context,
                "health_delayed_alarm_cancelled",
                "incident=$incident reason=incident_inactive_or_policy_changed"
            )
            return false
        }
        AppLog.event(context, "health_delayed_alarm_firing", "incident=$incident")
        playAlarm(context, prefs, incident)
        return true
    }

    fun incidentFromWorkerInput(value: String?): String =
        value?.takeIf { it == INCIDENT_PC_HEARTBEAT || it == INCIDENT_PUBLIC_TUNNEL }
            ?: INCIDENT_PC_HEARTBEAT

    private fun isActive(prefs: Prefs, incident: String): Boolean = when (incident) {
        INCIDENT_PUBLIC_TUNNEL -> prefs.tunnelIncidentActive
        else -> prefs.heartbeatIncidentActive
    }

    private fun setIncidentState(prefs: Prefs, incident: String, active: Boolean, atMs: Long) {
        when (incident) {
            INCIDENT_PUBLIC_TUNNEL -> {
                prefs.tunnelIncidentActive = active
                prefs.tunnelIncidentAtMs = atMs
            }
            else -> {
                prefs.heartbeatIncidentActive = active
                prefs.heartbeatIncidentAtMs = atMs
            }
        }
    }

    private fun alarmOwner(incident: String) = "watchdog:$incident"
    private fun delayedWorkName(incident: String) = "health-delayed-alarm:$incident"

    const val KEY_INCIDENT = "incident"
}
