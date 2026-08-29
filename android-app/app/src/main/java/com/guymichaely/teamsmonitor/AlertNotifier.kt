package com.guymichaely.teamsmonitor

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.concurrent.atomic.AtomicInteger

/** Shared notification/alarm path for both FCM and WebSocket delivery. */
object AlertNotifier {

    const val CHANNEL_ALERTS = "alerts2" // v2: silent channel; the app plays the alarm itself
    const val CHANNEL_ALERTS_LEGACY = "alerts"
    const val CHANNEL_SERVICE = "service"
    const val SERVICE_NOTIFICATION_ID = 1
    const val OWNER_ALERT = "alert"
    const val OWNER_WATCHDOG = "watchdog"

    private val nextId = AtomicInteger(100)

    /** Channel settings are immutable after creation — get them right here. */
    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.deleteNotificationChannel(CHANNEL_ALERTS_LEGACY)

        val alerts = NotificationChannel(
            CHANNEL_ALERTS,
            context.getString(R.string.channel_alerts),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            setSound(null, null)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            setBypassDnd(true)
        }

        val service = NotificationChannel(
            CHANNEL_SERVICE,
            context.getString(R.string.channel_service),
            NotificationManager.IMPORTANCE_LOW
        )

        nm.createNotificationChannels(listOf(alerts, service))
    }

    private var player: MediaPlayer? = null
    private var playerOwner: String? = null
    private var playbackGeneration = 0L
    private var volumeObserver: ContentObserver? = null
    private var observerContext: Context? = null

    /** UI hook: invoked on the main thread whenever playback starts or stops. */
    @Volatile var onPlaybackChanged: (() -> Unit)? = null

    @Synchronized
    fun playAlarm(
        context: Context,
        volume: Float = 1f,
        durationMs: Long = 8000,
        owner: String = OWNER_ALERT
    ) {
        stopAlarm("replaced")
        val generation = ++playbackGeneration
        val systemRingtone = Prefs(context).useSystemRingtone
        val sound = if (systemRingtone) {
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: Settings.System.DEFAULT_RINGTONE_URI
        } else {
            Uri.parse("android.resource://${context.packageName}/${R.raw.alarm}")
        }
        val p = MediaPlayer()
        try {
            p.setDataSource(context, sound)
            p.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            p.setVolume(volume, volume)
            p.isLooping = true
            p.prepare()
            p.start()
        } catch (e: Exception) {
            p.release()
            AppLog.event(
                context,
                "alarm_failure",
                "owner=$owner error=${e.javaClass.simpleName}:${e.message ?: ""} systemRingtone=$systemRingtone"
            )
            throw e
        }
        player = p
        playerOwner = owner
        AppLog.event(
            context,
            "alarm_started",
            "owner=$owner volume=$volume durationMs=$durationMs systemRingtone=$systemRingtone"
        )
        val appContext = context.applicationContext
        volumeObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                if (isAlarmPlaying()) stopAlarm("volume_changed")
            }
        }.also {
            appContext.contentResolver.registerContentObserver(
                Settings.System.CONTENT_URI, true, it
            )
        }
        observerContext = appContext
        notifyPlaybackChanged()
        Handler(Looper.getMainLooper()).postDelayed(
            { stopAlarmIfGeneration(generation, "timeout") },
            durationMs
        )
    }

    @Synchronized
    fun isAlarmPlaying(): Boolean = player?.isPlaying == true

    @Synchronized
    fun stopAlarmIfOwner(owner: String, reason: String): Boolean {
        if (playerOwner != owner || player == null) return false
        stopAlarm(reason)
        return true
    }

    @Synchronized
    private fun stopAlarmIfGeneration(generation: Long, reason: String) {
        if (generation != playbackGeneration || player == null) return
        stopAlarm(reason)
    }

    @Synchronized
    fun stopAlarm(reason: String = "unspecified") {
        val p = player ?: return
        val logContext = observerContext
        val owner = playerOwner
        try { p.stop() } catch (_: Exception) { /* already stopped */ }
        p.release()
        player = null
        playerOwner = null
        playbackGeneration++ // invalidate any timeout belonging to the stopped player
        volumeObserver?.let { observerContext?.contentResolver?.unregisterContentObserver(it) }
        volumeObserver = null
        observerContext = null
        logContext?.let { AppLog.event(it, "alarm_stopped", "owner=${owner ?: "unknown"} reason=$reason") }
        notifyPlaybackChanged()
    }

    private fun notifyPlaybackChanged() {
        Handler(Looper.getMainLooper()).post { onPlaybackChanged?.invoke() }
    }

    /** Applies the user's alert settings: notification on/off, alarm on/off + screen-on rule. */
    fun alert(context: Context, chat: String, author: String, text: String) {
        val prefs = Prefs(context)
        val screenOn = context.getSystemService(PowerManager::class.java)?.isInteractive == true
        val alarmWillPlay = prefs.alarmEnabled && (prefs.alarmWhenScreenOn || !screenOn)
        AppLog.event(
            context,
            "alert_dispatch",
            "chat=$chat author=$author notifEnabled=${prefs.notifEnabled} alarmEnabled=${prefs.alarmEnabled} screenOn=$screenOn alarmWhenScreenOn=${prefs.alarmWhenScreenOn} alarmWillPlay=$alarmWillPlay"
        )
        if (prefs.notifEnabled) show(context, chat, author, text)
        else AppLog.event(context, "notification_suppressed", "reason=app_setting")

        if (alarmWillPlay) {
            playAlarm(
                context,
                volume = prefs.alarmVolume / 100f,
                durationMs = prefs.alarmDurationSec * 1000L,
                owner = OWNER_ALERT
            )
        } else {
            val reason = if (!prefs.alarmEnabled) "app_setting" else "screen_on_rule"
            AppLog.event(context, "alarm_suppressed", "reason=$reason")
        }
    }

    fun show(context: Context, chat: String, author: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            AppLog.event(context, "notification_suppressed", "reason=permission")
            return
        }

        val compatManager = NotificationManagerCompat.from(context)
        if (!compatManager.areNotificationsEnabled()) {
            AppLog.event(context, "notification_suppressed", "reason=os_disabled")
            return
        }
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm?.getNotificationChannel(CHANNEL_ALERTS)?.importance == NotificationManager.IMPORTANCE_NONE) {
            AppLog.event(context, "notification_suppressed", "reason=channel_disabled")
            return
        }

        val tap = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val n = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("$author · $chat")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()

        val id = nextId.incrementAndGet()
        compatManager.notify(id, n)
        AppLog.event(context, "notification_posted", "id=$id chat=$chat author=$author")
    }
}
