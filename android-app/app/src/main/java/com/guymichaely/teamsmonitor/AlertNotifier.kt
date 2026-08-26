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

        // v1 channel had the sound baked in; the alarm now plays via MediaPlayer
        // (AlertNotifier.playAlarm), so the channel itself must be SILENT —
        // otherwise every alert double-plays. Clean up the legacy channel.
        nm.deleteNotificationChannel(CHANNEL_ALERTS_LEGACY)

        val alerts = NotificationChannel(
            CHANNEL_ALERTS,
            context.getString(R.string.channel_alerts),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            setSound(null, null) // silent on purpose — see playAlarm
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            // only takes effect if the user grants DND access
            setBypassDnd(true)
        }

        val service = NotificationChannel(
            CHANNEL_SERVICE,
            context.getString(R.string.channel_service),
            NotificationManager.IMPORTANCE_LOW
        )

        nm.createNotificationChannels(listOf(alerts, service))
    }

    // ---- alarm playback ------------------------------------------------------
    //
    // The alarm sound is played by the app on the ALARM stream rather than via
    // the notification channel: alarm-stream volume (not notification volume),
    // audible under Do-Not-Disturb (alarms are DND-exempt unless the user set
    // total silence), and no dependence on immutable channel settings.

    private var player: MediaPlayer? = null

    // Volume-button stop: apps can't intercept hardware volume keys in the
    // background, so while playing we watch the system volume settings —
    // any press changes a stream volume, and we treat that as "dismiss".
    // Our own MediaPlayer.setVolume doesn't touch system volumes, so the
    // app's volume slider can't self-trigger this.
    private var volumeObserver: ContentObserver? = null
    private var observerContext: Context? = null

    /** UI hook: invoked on the main thread whenever playback starts or stops. */
    @Volatile var onPlaybackChanged: (() -> Unit)? = null

    @Synchronized
    fun playAlarm(context: Context, volume: Float = 1f, durationMs: Long = 8000) {
        stopAlarm()
        val sound = if (Prefs(context).useSystemRingtone) {
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: Settings.System.DEFAULT_RINGTONE_URI
        } else {
            Uri.parse("android.resource://${context.packageName}/${R.raw.alarm}")
        }
        val p = MediaPlayer()
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
        player = p
        val appContext = context.applicationContext
        volumeObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                if (isAlarmPlaying()) stopAlarm()
            }
        }.also {
            appContext.contentResolver.registerContentObserver(
                Settings.System.CONTENT_URI, true, it
            )
        }
        observerContext = appContext
        notifyPlaybackChanged()
        Handler(Looper.getMainLooper()).postDelayed({ stopAlarm() }, durationMs)
    }

    @Synchronized
    fun isAlarmPlaying(): Boolean = player?.isPlaying == true

    @Synchronized
    fun stopAlarm() {
        val p = player ?: return
        try { p.stop() } catch (_: Exception) { /* already stopped */ }
        p.release()
        player = null
        volumeObserver?.let { observerContext?.contentResolver?.unregisterContentObserver(it) }
        volumeObserver = null
        observerContext = null
        notifyPlaybackChanged()
    }

    private fun notifyPlaybackChanged() {
        Handler(Looper.getMainLooper()).post { onPlaybackChanged?.invoke() }
    }

    /** Applies the user's alert settings: notification on/off, alarm on/off + screen-on rule. */
    fun alert(context: Context, chat: String, author: String, text: String) {
        val prefs = Prefs(context)
        if (prefs.notifEnabled) show(context, chat, author, text)
        val screenOn =
            context.getSystemService(PowerManager::class.java)?.isInteractive == true
        if (prefs.alarmEnabled && (prefs.alarmWhenScreenOn || !screenOn)) {
            playAlarm(
                context,
                volume = prefs.alarmVolume / 100f,
                durationMs = prefs.alarmDurationSec * 1000L
            )
        }
    }

    fun show(context: Context, chat: String, author: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return

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

        NotificationManagerCompat.from(context).notify(nextId.incrementAndGet(), n)
    }
}
