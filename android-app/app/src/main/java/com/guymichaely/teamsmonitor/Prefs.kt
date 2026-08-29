package com.guymichaely.teamsmonitor

import android.content.Context
import android.content.SharedPreferences

class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(KEY_URL, DEFAULT_URL) ?: DEFAULT_URL
        set(value) = sp.edit().putString(KEY_URL, value).apply()

    var token: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(value) = sp.edit().putString(KEY_TOKEN, value).apply()

    var alertTransport: String
        get() = sp.getString(KEY_ALERT_TRANSPORT, "websocket") ?: "websocket"
        set(value) = sp.edit().putString(KEY_ALERT_TRANSPORT, value).apply()

    var fcmFid: String
        get() = sp.getString(KEY_FCM_FID, "") ?: ""
        set(value) = sp.edit().putString(KEY_FCM_FID, value).apply()

    var fcmSyncPending: Boolean
        get() = sp.getBoolean(KEY_FCM_SYNC_PENDING, false)
        set(value) = sp.edit().putBoolean(KEY_FCM_SYNC_PENDING, value).apply()

    var fcmRegistrationUpdatedAtMs: Long
        get() = sp.getLong(KEY_FCM_UPDATED_AT, 0L)
        set(value) = sp.edit().putLong(KEY_FCM_UPDATED_AT, value).apply()

    /** Probe received over FCM but not yet confirmed as consumed by the PC. */
    var fcmProbeAckId: String
        get() = sp.getString(KEY_FCM_PROBE_ACK_ID, "") ?: ""
        set(value) = sp.edit().putString(KEY_FCM_PROBE_ACK_ID, value).apply()

    var websocketRecoveryRequested: Boolean
        get() = sp.getBoolean(KEY_WS_RECOVERY_REQUESTED, false)
        set(value) = sp.edit().putBoolean(KEY_WS_RECOVERY_REQUESTED, value).apply()

    var controlWorkerEnabled: Boolean
        get() = sp.getBoolean(KEY_WORKER_ENABLED, false)
        set(value) = sp.edit().putBoolean(KEY_WORKER_ENABLED, value).apply()

    var controlWorkerUrl: String
        get() = sp.getString(KEY_WORKER_URL, "") ?: ""
        set(value) = sp.edit().putString(KEY_WORKER_URL, value).apply()

    var lastControlSyncAtMs: Long
        get() = sp.getLong(KEY_CONTROL_SYNC_AT, 0L)
        set(value) = sp.edit().putLong(KEY_CONTROL_SYNC_AT, value).apply()

    /** notify | alarm_now | alarm_after_delay | ignore */
    var heartbeatPolicy: String
        get() = sp.getString(KEY_HEARTBEAT_POLICY, "notify") ?: "notify"
        set(value) = sp.edit().putString(KEY_HEARTBEAT_POLICY, value).apply()

    var heartbeatDelayMinutes: Int
        get() = sp.getInt(KEY_HEARTBEAT_DELAY_MINUTES, 15)
        set(value) = sp.edit().putInt(KEY_HEARTBEAT_DELAY_MINUTES, value.coerceIn(1, 1440)).apply()

    var heartbeatIncidentActive: Boolean
        get() = sp.getBoolean(KEY_HEARTBEAT_INCIDENT_ACTIVE, false)
        set(value) = sp.edit().putBoolean(KEY_HEARTBEAT_INCIDENT_ACTIVE, value).apply()

    var heartbeatIncidentAtMs: Long
        get() = sp.getLong(KEY_HEARTBEAT_INCIDENT_AT, 0L)
        set(value) = sp.edit().putLong(KEY_HEARTBEAT_INCIDENT_AT, value).apply()

    /** False until the user has saved settings once. */
    val configured: Boolean
        get() = sp.contains(KEY_URL)

    /** One-shot flag: auto-open the DND-access settings screen only once. */
    var dndPromptShown: Boolean
        get() = sp.getBoolean(KEY_DND_PROMPT, false)
        set(value) = sp.edit().putBoolean(KEY_DND_PROMPT, value).apply()

    var alarmEnabled: Boolean
        get() = sp.getBoolean(KEY_ALARM_ENABLED, true)
        set(value) = sp.edit().putBoolean(KEY_ALARM_ENABLED, value).apply()

    var notifEnabled: Boolean
        get() = sp.getBoolean(KEY_NOTIF_ENABLED, true)
        set(value) = sp.edit().putBoolean(KEY_NOTIF_ENABLED, value).apply()

    /** When false, the alarm sound is suppressed while the screen is on. */
    var alarmWhenScreenOn: Boolean
        get() = sp.getBoolean(KEY_ALARM_SCREEN_ON, false)
        set(value) = sp.edit().putBoolean(KEY_ALARM_SCREEN_ON, value).apply()

    var alarmVolume: Int
        get() = sp.getInt(KEY_ALARM_VOLUME, 100)
        set(value) = sp.edit().putInt(KEY_ALARM_VOLUME, value.coerceIn(0, 100)).apply()

    var alarmDurationSec: Int
        get() = sp.getInt(KEY_ALARM_DURATION, 8)
        set(value) = sp.edit().putInt(KEY_ALARM_DURATION, value.coerceIn(1, 300)).apply()

    /** True: phone's built-in alarm ringtone; false: bundled alarm.wav. */
    var useSystemRingtone: Boolean
        get() = sp.getBoolean(KEY_USE_SYSTEM_RINGTONE, true)
        set(value) = sp.edit().putBoolean(KEY_USE_SYSTEM_RINGTONE, value).apply()

    companion object {
        const val DEFAULT_URL = ""
        private const val KEY_URL = "server_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_ALERT_TRANSPORT = "alert_transport"
        private const val KEY_FCM_FID = "fcm_fid"
        private const val KEY_FCM_SYNC_PENDING = "fcm_sync_pending"
        private const val KEY_FCM_UPDATED_AT = "fcm_registration_updated_at_ms"
        private const val KEY_FCM_PROBE_ACK_ID = "fcm_probe_ack_id"
        private const val KEY_WS_RECOVERY_REQUESTED = "websocket_recovery_requested"
        private const val KEY_WORKER_ENABLED = "control_worker_enabled"
        private const val KEY_WORKER_URL = "control_worker_url"
        private const val KEY_CONTROL_SYNC_AT = "last_control_sync_at_ms"
        private const val KEY_HEARTBEAT_POLICY = "heartbeat_policy"
        private const val KEY_HEARTBEAT_DELAY_MINUTES = "heartbeat_delay_minutes"
        private const val KEY_HEARTBEAT_INCIDENT_ACTIVE = "heartbeat_incident_active"
        private const val KEY_HEARTBEAT_INCIDENT_AT = "heartbeat_incident_at_ms"
        private const val KEY_DND_PROMPT = "dnd_prompt_shown"
        private const val KEY_ALARM_ENABLED = "alarm_enabled"
        private const val KEY_NOTIF_ENABLED = "notif_enabled"
        private const val KEY_ALARM_SCREEN_ON = "alarm_when_screen_on"
        private const val KEY_ALARM_VOLUME = "alarm_volume"
        private const val KEY_ALARM_DURATION = "alarm_duration_sec"
        private const val KEY_USE_SYSTEM_RINGTONE = "use_system_ringtone"
    }
}
