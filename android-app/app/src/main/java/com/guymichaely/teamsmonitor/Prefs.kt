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
        private const val KEY_DND_PROMPT = "dnd_prompt_shown"
        private const val KEY_ALARM_ENABLED = "alarm_enabled"
        private const val KEY_NOTIF_ENABLED = "notif_enabled"
        private const val KEY_ALARM_SCREEN_ON = "alarm_when_screen_on"
        private const val KEY_ALARM_VOLUME = "alarm_volume"
        private const val KEY_ALARM_DURATION = "alarm_duration_sec"
        private const val KEY_USE_SYSTEM_RINGTONE = "use_system_ringtone"
    }
}
