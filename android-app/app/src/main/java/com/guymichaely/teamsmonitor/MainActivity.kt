package com.guymichaely.teamsmonitor

import android.Manifest
import android.app.NotificationManager
import android.app.AlertDialog
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
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
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
import java.time.Instant

/** Native control panel: connection status, last alert, and action buttons. */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private var exportingDiagnostics = false
    private var rangeStartMs = 0L
    private var rangeEndMs = 0L
    private var deleteCutoffMs = 0L
    private val settingsListener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> refreshStatus() }

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
        deleteCutoffMs = savedInstanceState?.getLong(STATE_DELETE_CUTOFF) ?: System.currentTimeMillis()

        prefs = Prefs(this)
        findViewById<TextView>(R.id.conn_status).setOnClickListener {
            fun timestamp(value: Long) = if (value > 0) DateFormat.getDateTimeInstance().format(java.util.Date(value)) else "Not observed"
            AlertDialog.Builder(this)
                .setTitle("Alert delivery status")
                .setMessage("Last control update: ${timestamp(prefs.lastControlSyncAtMs)}\n" +
                    "Last FCM receipt (alert or control): ${timestamp(prefs.lastFcmReceiptAtMs)}\n\n" +
                    "FCM ready means registration is synced with no known registration problem, not a verified live connection. " +
                    "Off means not used for alert delivery; FCM can still receive control messages. " +
                    "Server delivery health is the last observed state. See diagnostics for errors.")
                .setPositiveButton("Close", null).show()
        }
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
        findViewById<Button>(R.id.diagnostics_delete_cutoff).setOnClickListener { chooseDeleteCutoff() }
        val deleteMode = findViewById<Spinner>(R.id.diagnostics_delete_mode)
        deleteMode.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                findViewById<Button>(R.id.diagnostics_delete_cutoff).visibility = if (position == 0) View.VISIBLE else View.GONE
                findViewById<EditText>(R.id.diagnostics_delete_age).visibility = if (position == 7) View.VISIBLE else View.GONE
            }
        }
        findViewById<Button>(R.id.diagnostics_delete_cutoff).visibility = if (deleteMode.selectedItemPosition == 0) View.VISIBLE else View.GONE
        findViewById<EditText>(R.id.diagnostics_delete_age).visibility = if (deleteMode.selectedItemPosition == 7) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.btn_delete_diagnostics).setOnClickListener { reviewDiagnosticsDeletion() }
        updateDeleteCutoffLabel()

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
                            clipboard.setPrimaryClip(ClipData.newPlainText("TM diagnostics", report))
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

    private fun chooseDeleteCutoff() {
        val current = Calendar.getInstance().apply { timeInMillis = deleteCutoffMs }
        DatePickerDialog(this, { _, year, month, day ->
            TimePickerDialog(this, { _, hour, minute ->
                deleteCutoffMs = Calendar.getInstance().apply {
                    set(year, month, day, hour, minute, 0)
                    set(Calendar.MILLISECOND, 0)
                }.timeInMillis
                updateDeleteCutoffLabel()
            }, current.get(Calendar.HOUR_OF_DAY), current.get(Calendar.MINUTE), android.text.format.DateFormat.is24HourFormat(this)).show()
        }, current.get(Calendar.YEAR), current.get(Calendar.MONTH), current.get(Calendar.DAY_OF_MONTH)).show()
    }

    private fun updateDeleteCutoffLabel() {
        val formatter = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
        findViewById<Button>(R.id.diagnostics_delete_cutoff).text =
            "${getString(R.string.diagnostics_delete_cutoff_label)}: ${formatter.format(java.util.Date(deleteCutoffMs))}"
    }

    private fun reviewDiagnosticsDeletion() {
        val ageMode = findViewById<Spinner>(R.id.diagnostics_delete_mode).selectedItemPosition
        val cutoff = if (ageMode > 0) {
            val days = if (ageMode == 7) findViewById<EditText>(R.id.diagnostics_delete_age).text.toString().toLongOrNull()
                else listOf(1L, 7L, 30L, 90L, 180L, 365L).getOrNull(ageMode - 1)
            if (days == null || days <= 0L || days > 36500L) {
                Toast.makeText(this, R.string.diagnostics_delete_age_hint, Toast.LENGTH_LONG).show()
                return
            }
            System.currentTimeMillis() - days * 24L * 60L * 60L * 1000L
        } else deleteCutoffMs
        setDiagnosticsDeleteEnabled(false)
        Thread({
            val preview = runCatching { AppLog.previewDeleteBefore(applicationContext, Instant.ofEpochMilli(cutoff)) }
            runOnUiThread {
                setDiagnosticsDeleteEnabled(true)
                if (isFinishing || isDestroyed) return@runOnUiThread
                preview.fold(onSuccess = { result ->
                    val label = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                        .format(java.util.Date(cutoff))
                    AlertDialog.Builder(this)
                        .setTitle(R.string.delete_diagnostics_before)
                        .setMessage(getString(R.string.diagnostics_delete_confirm, result.deletedCount, label))
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(android.R.string.ok) { _, _ -> performDiagnosticsDeletion(cutoff) }
                        .show()
                }, onFailure = { Toast.makeText(this, R.string.diagnostics_delete_failed, Toast.LENGTH_LONG).show() })
            }
        }, "diagnostics-delete-preview").start()
    }

    private fun performDiagnosticsDeletion(cutoff: Long) {
        setDiagnosticsDeleteEnabled(false)
        Thread({
            val result = runCatching { AppLog.deleteBefore(applicationContext, Instant.ofEpochMilli(cutoff)) }
            runOnUiThread {
                setDiagnosticsDeleteEnabled(true)
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.fold(onSuccess = {
                    Toast.makeText(this, getString(R.string.diagnostics_delete_done, it.deletedCount, it.retainedCount), Toast.LENGTH_LONG).show()
                }, onFailure = { Toast.makeText(this, R.string.diagnostics_delete_failed, Toast.LENGTH_LONG).show() })
            }
        }, "diagnostics-delete").start()
    }

    private fun setDiagnosticsDeleteEnabled(enabled: Boolean) {
        findViewById<Button>(R.id.btn_delete_diagnostics).isEnabled = enabled
        findViewById<Button>(R.id.diagnostics_delete_cutoff).isEnabled = enabled
        findViewById<EditText>(R.id.diagnostics_delete_age).isEnabled = enabled
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
        outState.putLong(STATE_DELETE_CUTOFF, deleteCutoffMs)
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
        prefs.observe(settingsListener)
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
        prefs.stopObserving(settingsListener)
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
            AlertState.Connection.CONNECTING -> "connecting"
            AlertState.Connection.RECONNECTING -> "reconnecting"
            AlertState.Connection.DISCONNECTED -> "disconnected"
        }
        val snapshot = runCatching { org.json.JSONObject(prefs.deliveryStatusSnapshot) }.getOrNull()
        val delivery = snapshot?.takeIf { it.optString("primary") == prefs.alertTransport }?.optJSONObject("delivery")
        val parts = DeliveryStatus.parts(
            prefs.alertTransport, prefs.fallbackTransport, prefs.websocketRecoveryRequested,
            conn, prefs.fcmFid.isNotBlank(), prefs.fcmSyncPending, prefs.fcmRegistrationStatus,
            delivery?.optString("state") ?: "unknown", delivery?.optString("activeTransport") ?: "unknown",
            fcmAvailable = com.google.firebase.FirebaseApp.getApps(this).isNotEmpty()
        )
        val status = SpannableStringBuilder("Alerts: ")
        val dark = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        parts.forEachIndexed { index, part ->
            if (index > 0) status.append(" • ")
            val start = status.length
            status.append(part.text)
            val color = when (part.tone) {
                DeliveryStatus.Tone.GOOD -> if (dark) 0xFF81C784.toInt() else 0xFF256029.toInt()
                DeliveryStatus.Tone.WAITING -> if (dark) 0xFFFFC107.toInt() else 0xFF805500.toInt()
                DeliveryStatus.Tone.ERROR -> if (dark) 0xFFEF9A9A.toInt() else 0xFFB71C1C.toInt()
                DeliveryStatus.Tone.MUTED -> if (dark) 0xFFAAAAAA.toInt() else 0xFF666666.toInt()
            }
            status.setSpan(ForegroundColorSpan(color), start, status.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        findViewById<TextView>(R.id.conn_status).text = status
        findViewById<TextView>(R.id.server).text =
            "Server: ${prefs.serverUrl.ifBlank { "(not set)" }}"
        findViewById<TextView>(R.id.last_alert).text =
            if (AlertState.lastAlertBody != null) {
                "${AlertState.lastAlertTitle}\n" +
                    "${AlertState.lastAlertBody}\n${AlertState.lastAlertAt}"
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
        private const val STATE_DELETE_CUTOFF = "diagnostics_delete_cutoff"
        private const val CUSTOM_RANGE_POSITION = 4
        private val COLOR_TOGGLE_ON = 0xFF2E7D32.toInt()
        private val COLOR_TOGGLE_OFF = 0xFF757575.toInt()
    }
}
