package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class ControlSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : Worker(appContext, params) {

    override fun doWork(): Result {
        return if (NotificationTransport.syncBlocking(applicationContext)) {
            Result.success()
        } else {
            // Periodic work will run again on its normal cadence. During active
            // FCM registration recovery, the dedicated registration worker has
            // its own faster exponential retry loop.
            Result.success()
        }
    }
}
