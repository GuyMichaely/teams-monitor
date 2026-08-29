package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class HeartbeatAlarmWorker(
    appContext: Context,
    params: WorkerParameters
) : Worker(appContext, params) {
    override fun doWork(): Result {
        val incident = HealthIncidentManager.incidentFromWorkerInput(
            inputData.getString(HealthIncidentManager.KEY_INCIDENT)
        )
        HealthIncidentManager.fireDelayedAlarm(applicationContext, incident)
        return Result.success()
    }
}
