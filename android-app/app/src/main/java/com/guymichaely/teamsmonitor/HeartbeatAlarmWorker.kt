package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class HeartbeatAlarmWorker(
    appContext: Context,
    params: WorkerParameters
) : Worker(appContext, params) {
    override fun doWork(): Result {
        HealthIncidentManager.fireDelayedAlarm(applicationContext)
        return Result.success()
    }
}
