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

/**
 * Single entry point for raising an alert. Called by the WebSocket path
 * (AlertService) today; a future FirebaseMessagingService should call [alert]
 * too instead of building its own notifications.
 */
object AlertNotifier {

    const val CHANNEL_ALERTS = "alerts2" // v2: silent channel; the app plays the alarm itself
    const val CHANNEL_ALERTS_LEGACY = "alerts"
    const val CHANNEL_SERVICE = "service"
    const val SERVICE_NOTIFICATION_ID = 1

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
    private var volumeObserver: ContentObserver? = null
    private var observerContext: Context? = null

    /** UI hook: invoked on the main thread whenever playback starts or stops. */
    @Volatile var onPlaybackChanged: (() -> Unit)? = null

    @Synchronized
    fun playAlarm(context: Context, volume: Float = 1f, durationMs: Long = 8000) {
        stopAlarm("replaced")
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
                "error=${e.javaClass.simpleName}:${e.message ?: ""} systemRingtone=$systemRingtone"
            )
            throw e
        }
        player = p
        AppLog.event(
            context,
            "alarm_started",
            "volume=$volume durationMs=$durationMs systemRingtone=$systemRingtone"
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
        Handler(Looper.getMainLooper()).postDelayed({ stopAlarm("timeout") }, durationMs)
    }

    @Synchronized
    fun isAlarmPlaying(): Boolean = player?.isPlaying == true

    @Synchronized
    fun stopAlarm(reason: String = "unspecified") {
        val p = player ?: return
        val logContext = observerContext
        try { p.stop() } catch (_: Exception) { /* already stopped */ }
        p.release()
        player = null
        volumeObserver?.let { observerContext?.contentResolver?.unregisterContentObserver(it) }
        volumeObserver = null
        observerContext = null
        logContext?.let { AppLog.event(it, "alarm_stopped", "reason=$reason") }
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
                durationMs = prefs.alarmDurationSec * 1000L
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
