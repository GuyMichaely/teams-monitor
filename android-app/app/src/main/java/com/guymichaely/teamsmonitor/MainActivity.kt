package com.guymichaely.teamsmonitor

import android.Manifest
import android.app.NotificationManager
import android.app.DatePickerDialog
import android.app.TimePickerDialog
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
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.text.DateFormat
import java.util.Calendar

/** Native control panel: connection status, last alert, and action buttons. */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private var exportingDiagnostics = false
    private var rangeStartMs = 0L
    private var rangeEndMs = 0L

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

        val today = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        rangeStartMs = savedInstanceState?.getLong(STATE_RANGE_START) ?: today.timeInMillis
        rangeEndMs = savedInstanceState?.getLong(STATE_RANGE_END) ?: System.currentTimeMillis()

        prefs = Prefs(this)
        AlertNotifier.createChannels(this)
        AppLog.event(this, "main_create", "network=${AppLog.networkSummary(this)}")

        findViewById<View>(R.id.dnd_fix).setOnClickListener { openDndSettings() }

        val windowSpinner = findViewById<Spinner>(R.id.diagnostics_window)
        windowSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                val visibility = if (position == CUSTOM_RANGE_POSITION) View.VISIBLE else View.GONE
                findViewById<Button>(R.id.diagnostics_from).visibility = visibility
                findViewById<Button>(R.id.diagnostics_to).visibility = visibility
                updateRangeButtonLabels()
            }
        }
        findViewById<Button>(R.id.diagnostics_from).setOnClickListener { chooseRangeDateTime(true) }
        findViewById<Button>(R.id.diagnostics_to).setOnClickListener { chooseRangeDateTime(false) }

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
            exportDiagnostics(share = false)
        }
        findViewById<Button>(R.id.btn_share_diagnostics).setOnClickListener {
            exportDiagnostics(share = true)
        }

        requestNotifPermission()

        if (!prefs.configured || prefs.serverUrl.isBlank()) {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
    }

    private fun exportDiagnostics(share: Boolean) {
        if (exportingDiagnostics) return
        val customRange = findViewById<Spinner>(R.id.diagnostics_window).selectedItemPosition == CUSTOM_RANGE_POSITION
        if (customRange && rangeStartMs > rangeEndMs) {
            Toast.makeText(this, R.string.diagnostics_range_invalid, Toast.LENGTH_LONG).show()
            return
        }
        val windows = listOf(60 * 60 * 1000L, 24 * 60 * 60 * 1000L, 7 * 24 * 60 * 60 * 1000L, null, null)
        val filter = DiagnosticsFilter(
            windowMs = if (customRange) null else windows[findViewById<Spinner>(R.id.diagnostics_window).selectedItemPosition],
            category = DiagnosticsFilter.Category.values()[findViewById<Spinner>(R.id.diagnostics_category).selectedItemPosition],
            query = findViewById<EditText>(R.id.diagnostics_search).text.toString().trim(),
            rangeStartMs = if (customRange) rangeStartMs else null,
            rangeEndMs = if (customRange) rangeEndMs else null,
            localZoneId = java.util.TimeZone.getDefault().id
        )
        exportingDiagnostics = true
        setDiagnosticsButtonsEnabled(false)
        val app = applicationContext
        Thread({
            val result = runCatching {
                val report = AppLog.report(app, filter)
                report to if (share) DiagnosticsExport.shareIntent(app, report) else null
            }
            runOnUiThread {
                exportingDiagnostics = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                setDiagnosticsButtonsEnabled(true)
                result.fold(onSuccess = { (report, intent) ->
                    runCatching {
                        if (intent != null) {
                            startActivity(Intent.createChooser(intent, getString(R.string.share_diagnostics)))
                        } else {
                            val clipboard = getSystemService(ClipboardManager::class.java)
                                ?: error("Clipboard unavailable")
                            clipboard.setPrimaryClip(ClipData.newPlainText("Teams Monitor diagnostics", report))
                            Toast.makeText(this, R.string.diagnostics_copied, Toast.LENGTH_SHORT).show()
                        }
                    }.onFailure { diagnosticsExportFailed() }
                }, onFailure = { diagnosticsExportFailed() })
            }
        }, "diagnostics-export").start()
    }

    private fun chooseRangeDateTime(isStart: Boolean) {
        val current = Calendar.getInstance().apply { timeInMillis = if (isStart) rangeStartMs else rangeEndMs }
        DatePickerDialog(this, { _, year, month, day ->
            TimePickerDialog(this, { _, hour, minute ->
                val chosen = Calendar.getInstance().apply {
                    set(year, month, day, hour, minute, if (isStart) 0 else 59)
                    set(Calendar.MILLISECOND, if (isStart) 0 else 999)
                }.timeInMillis
                if (isStart) rangeStartMs = chosen else rangeEndMs = chosen
                updateRangeButtonLabels()
            }, current.get(Calendar.HOUR_OF_DAY), current.get(Calendar.MINUTE), android.text.format.DateFormat.is24HourFormat(this)).show()
        }, current.get(Calendar.YEAR), current.get(Calendar.MONTH), current.get(Calendar.DAY_OF_MONTH)).show()
    }

    private fun updateRangeButtonLabels() {
        val formatter = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
        findViewById<Button>(R.id.diagnostics_from).text =
            "${getString(R.string.diagnostics_from_label)}: ${formatter.format(java.util.Date(rangeStartMs))}"
        findViewById<Button>(R.id.diagnostics_to).text =
            "${getString(R.string.diagnostics_to_label)}: ${formatter.format(java.util.Date(rangeEndMs))}"
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong(STATE_RANGE_START, rangeStartMs)
        outState.putLong(STATE_RANGE_END, rangeEndMs)
        super.onSaveInstanceState(outState)
    }

    private fun setDiagnosticsButtonsEnabled(enabled: Boolean) {
        findViewById<Button>(R.id.btn_copy_diagnostics).isEnabled = enabled
        findViewById<Button>(R.id.btn_share_diagnostics).isEnabled = enabled
    }

    private fun diagnosticsExportFailed() {
        Toast.makeText(this, R.string.diagnostics_export_failed, Toast.LENGTH_LONG).show()
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
        NotificationTransport.sync(this)
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
        findViewById<TextView>(R.id.conn_status).text = when (prefs.alertTransport) {
            "fcm" -> if (prefs.websocketRecoveryRequested) {
                "Alerts: FCM primary · WebSocket fallback $conn"
            } else {
                "Alerts: FCM primary · WebSocket standby"
            }
            else -> "Alerts: WebSocket primary · $conn"
        }
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
        private const val STATE_RANGE_START = "diagnostics_range_start"
        private const val STATE_RANGE_END = "diagnostics_range_end"
        private const val CUSTOM_RANGE_POSITION = 4
        private val COLOR_TOGGLE_ON = 0xFF2E7D32.toInt()
        private val COLOR_TOGGLE_OFF = 0xFF757575.toInt()
    }
}
