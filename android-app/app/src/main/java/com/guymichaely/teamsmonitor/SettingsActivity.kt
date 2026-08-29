package com.guymichaely.teamsmonitor

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat

class SettingsActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        prefs = Prefs(this)

        val urlField = findViewById<EditText>(R.id.server_url)
        val tokenField = findViewById<EditText>(R.id.token)
        val alarmEnabled = findViewById<SwitchCompat>(R.id.alarm_enabled)
        val notifEnabled = findViewById<SwitchCompat>(R.id.notif_enabled)
        val alarmScreenOn = findViewById<SwitchCompat>(R.id.alarm_screen_on)
        val useSystemRingtone = findViewById<SwitchCompat>(R.id.use_system_ringtone)
        val volume = findViewById<SeekBar>(R.id.alarm_volume)
        val volumeValue = findViewById<TextView>(R.id.volume_value)
        val duration = findViewById<EditText>(R.id.alarm_duration)
        val heartbeatPolicy = findViewById<Spinner>(R.id.heartbeat_policy)
        val heartbeatDelay = findViewById<EditText>(R.id.heartbeat_delay)
        val heartbeatPolicyValues = resources.getStringArray(R.array.heartbeat_policy_values)

        urlField.setText(prefs.serverUrl)
        tokenField.setText(prefs.token)
        alarmEnabled.isChecked = prefs.alarmEnabled
        notifEnabled.isChecked = prefs.notifEnabled
        alarmScreenOn.isChecked = prefs.alarmWhenScreenOn
        useSystemRingtone.isChecked = prefs.useSystemRingtone
        volume.progress = prefs.alarmVolume
        volumeValue.text = prefs.alarmVolume.toString()
        duration.setText(prefs.alarmDurationSec.toString())
        heartbeatDelay.setText(prefs.heartbeatDelayMinutes.toString())

        ArrayAdapter.createFromResource(
            this,
            R.array.heartbeat_policy_labels,
            android.R.layout.simple_spinner_item
        ).also { adapter ->
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            heartbeatPolicy.adapter = adapter
        }
        heartbeatPolicy.setSelection(
            heartbeatPolicyValues.indexOf(prefs.heartbeatPolicy).takeIf { it >= 0 } ?: 0
        )

        volume.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                volumeValue.text = progress.toString()
                if (fromUser) AlertNotifier.stopAlarm("settings_volume_changed")
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        })

        findViewById<Button>(R.id.save).setOnClickListener {
            prefs.serverUrl = urlField.text.toString().trim()
            prefs.token = tokenField.text.toString().trim()
            prefs.alarmEnabled = alarmEnabled.isChecked
            prefs.notifEnabled = notifEnabled.isChecked
            prefs.alarmWhenScreenOn = alarmScreenOn.isChecked
            prefs.useSystemRingtone = useSystemRingtone.isChecked
            prefs.alarmVolume = volume.progress
            prefs.alarmDurationSec = duration.text.toString().toIntOrNull() ?: 8
            prefs.heartbeatPolicy = heartbeatPolicyValues.getOrElse(heartbeatPolicy.selectedItemPosition) {
                HealthIncidentManager.POLICY_NOTIFY
            }
            prefs.heartbeatDelayMinutes = heartbeatDelay.text.toString().toIntOrNull() ?: 15
            AppLog.event(
                this,
                "settings_saved",
                "server=${prefs.serverUrl} tokenConfigured=${prefs.token.isNotBlank()} alarmEnabled=${prefs.alarmEnabled} notifEnabled=${prefs.notifEnabled} alarmWhenScreenOn=${prefs.alarmWhenScreenOn} useSystemRingtone=${prefs.useSystemRingtone} alarmVolume=${prefs.alarmVolume} alarmDurationSec=${prefs.alarmDurationSec} heartbeatPolicy=${prefs.heartbeatPolicy} heartbeatDelayMinutes=${prefs.heartbeatDelayMinutes}"
            )
            NotificationTransport.sync(this)
            setResult(RESULT_OK)
            finish()
        }
    }
}
