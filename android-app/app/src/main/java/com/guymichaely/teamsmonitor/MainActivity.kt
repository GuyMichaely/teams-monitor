package com.guymichaely.teamsmonitor

import android.Manifest
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/** Native control panel: connection status, last alert, and action buttons. */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = refreshStatus()
    }

    private val notifPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            AppLog.event(this, "notification_permission_result", "granted=$granted")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = Prefs(this)
        AlertNotifier.createChannels(this)
        AppLog.event(this, "main_create", "network=${AppLog.networkSummary(this)}")

        findViewById<View>(R.id.dnd_fix).setOnClickListener { openDndSettings() }

        findViewById<Button>(R.id.toggle_alarm_sound).setOnClickListener {
            prefs.alarmEnabled = !prefs.alarmEnabled
            AppLog.event(this, "setting_changed", "alarmEnabled=${prefs.alarmEnabled}")
            refreshToggles()
        }
        findViewById<Button>(R.id.toggle_notifications).setOnClickListener {
            prefs.notifEnabled = !prefs.notifEnabled
            AppLog.event(this, "setting_changed", "notifEnabled=${prefs.notifEnabled}")
            refreshToggles()
        }
        findViewById<Button>(R.id.toggle_screen_on).setOnClickListener {
            prefs.alarmWhenScreenOn = !prefs.alarmWhenScreenOn
            AppLog.event(this, "setting_changed", "alarmWhenScreenOn=${prefs.alarmWhenScreenOn}")
            refreshToggles()
        }

        findViewById<Button>(R.id.btn_dashboard).setOnClickListener {
            if (prefs.serverUrl.isBlank()) {
                startActivity(Intent(this, SettingsActivity::class.java))
            } else {
                startActivity(Intent(this, DashboardActivity::class.java))
            }
        }
        findViewById<Button>(R.id.btn_settings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        findViewById<Button>(R.id.btn_battery).setOnClickListener {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                )
            )
        }
        findViewById<Button>(R.id.btn_test_alarm).setOnClickListener {
            if (AlertNotifier.isAlarmPlaying()) {
                AlertNotifier.stopAlarm("test_button")
            } else {
                AppLog.event(this, "alarm_test_requested")
                AlertNotifier.playAlarm(
                    this,
                    volume = prefs.alarmVolume / 100f,
                    durationMs = prefs.alarmDurationSec * 1000L
                )
            }
            refreshTestButton()
        }
        findViewById<Button>(R.id.btn_copy_diagnostics).setOnClickListener {
            AppLog.event(this, "diagnostics_copied")
            val clipboard = getSystemService(ClipboardManager::class.java)
            clipboard?.setPrimaryClip(ClipData.newPlainText("Teams Monitor diagnostics", AppLog.report(this)))
            Toast.makeText(this, R.string.diagnostics_copied, Toast.LENGTH_SHORT).show()
        }

        AlertService.start(this)
        requestNotifPermission()

        if (!prefs.configured || prefs.serverUrl.isBlank()) {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        AppLog.event(this, "main_resume", "network=${AppLog.networkSummary(this)}")
        AlertNotifier.stopAlarm("app_resume")
        AlertNotifier.onPlaybackChanged = { refreshTestButton() }
        ContextCompat.registerReceiver(
            this, statusReceiver, IntentFilter(AlertState.ACTION_STATUS),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        refreshStatus()
        refreshTestButton()
        refreshToggles()

        val nm = getSystemService(NotificationManager::class.java)
        val granted = nm?.isNotificationPolicyAccessGranted == true
        findViewById<View>(R.id.dnd_banner).visibility =
            if (granted) View.GONE else View.VISIBLE
        if (!granted && !prefs.dndPromptShown) {
            prefs.dndPromptShown = true
            openDndSettings()
        }
    }

    override fun onPause() {
        AlertNotifier.onPlaybackChanged = null
        unregisterReceiver(statusReceiver)
        super.onPause()
    }

    private fun refreshTestButton() {
        findViewById<Button>(R.id.btn_test_alarm).setText(
            if (AlertNotifier.isAlarmPlaying()) R.string.stop_alarm else R.string.test_alarm
        )
    }

    private fun refreshToggles() {
        styleToggle(R.id.toggle_alarm_sound, getString(R.string.toggle_alarm_sound), prefs.alarmEnabled)
        styleToggle(R.id.toggle_notifications, getString(R.string.toggle_notifications), prefs.notifEnabled)
        styleToggle(R.id.toggle_screen_on, getString(R.string.toggle_screen_on), prefs.alarmWhenScreenOn)
    }

    private fun styleToggle(id: Int, label: String, on: Boolean) {
        val b = findViewById<Button>(id)
        b.text = "$label — ${getString(if (on) R.string.state_on else R.string.state_off)}"
        b.setBackgroundColor(if (on) COLOR_TOGGLE_ON else COLOR_TOGGLE_OFF)
        b.setTextColor(0xFFFFFFFF.toInt())
    }

    private fun refreshStatus() {
        val conn = when (AlertState.connection) {
            AlertState.Connection.CONNECTED -> "connected"
            AlertState.Connection.CONNECTING -> "connecting…"
            AlertState.Connection.DISCONNECTED -> "disconnected"
        }
        findViewById<TextView>(R.id.conn_status).text = "WebSocket: $conn"
        findViewById<TextView>(R.id.server).text =
            "Server: ${prefs.serverUrl.ifBlank { "(not set)" }}"
        findViewById<TextView>(R.id.last_alert).text =
            if (AlertState.lastAlertText != null) {
                "${AlertState.lastAlertAuthor} · ${AlertState.lastAlertChat}\n" +
                    "${AlertState.lastAlertText}\n${AlertState.lastAlertAt}"
            } else {
                "No alerts received yet"
            }
    }

    private fun openDndSettings() {
        AppLog.event(this, "dnd_settings_opened")
        startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
    }

    private fun requestNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            AppLog.event(this, "notification_permission_requested")
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        private val COLOR_TOGGLE_ON = 0xFF2E7D32.toInt()
        private val COLOR_TOGGLE_OFF = 0xFF757575.toInt()
    }
}
