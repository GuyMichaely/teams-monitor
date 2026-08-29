package com.guymichaely.teamsmonitor

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.TimeUnit

class FcmRegistrationWorker(
    appContext: Context,
    params: WorkerParameters
) : Worker(appContext, params) {

    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        if (!prefs.fcmSyncPending) return Result.success()

        if (prefs.fcmFid.isNotBlank()) {
            return if (FcmRegistration.syncStoredBlocking(applicationContext)) {
                Result.success()
            } else {
                Result.retry()
            }
        }

        if (FirebaseApp.getApps(applicationContext).isEmpty()) return Result.failure()

        return try {
            // Success causes FirebaseMessagingService.onRegistered(fid) to run,
            // which persists the FID and schedules the server sync.
            Tasks.await(FirebaseMessaging.getInstance().register(), 20, TimeUnit.SECONDS)
            AppLog.event(applicationContext, "fcm_registration_worker_ok")
            Result.success()
        } catch (e: Exception) {
            AppLog.event(
                applicationContext,
                "fcm_registration_worker_failed",
                "error=${e.javaClass.simpleName}:${e.message ?: ""}"
            )
            Result.retry()
        }
    }
}
