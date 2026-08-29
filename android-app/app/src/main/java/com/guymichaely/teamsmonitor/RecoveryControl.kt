package com.guymichaely.teamsmonitor

import android.content.Context

object RecoveryControl {

    fun applyServerState(
        context: Context,
        primaryTransport: String,
        websocketWanted: Boolean,
        fcmRegistrationStatus: String? = null,
        workerEnabled: Boolean? = null,
        workerUrl: String? = null
    ) {
        val app = context.applicationContext
        val prefs = Prefs(app)

        if (primaryTransport == "fcm" || primaryTransport == "websocket") {
            prefs.alertTransport = primaryTransport
        }
        prefs.websocketRecoveryRequested = websocketWanted
        if (workerEnabled != null) prefs.controlWorkerEnabled = workerEnabled
        if (workerUrl != null) prefs.controlWorkerUrl = workerUrl
        prefs.lastControlSyncAtMs = System.currentTimeMillis()

        if (fcmRegistrationStatus == "suspect") {
            FcmRegistration.ensureRegistered(app, "server_registration_suspect")
        }

        applyWebSocketPolicy(app)
    }

    fun handleControlMessage(context: Context, actions: Collection<String>) {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val normalized = actions.map { it.trim() }.filter { it.isNotEmpty() }.toSet()

        if ("ensure_fcm_registration" in normalized) {
            FcmRegistration.ensureRegistered(app, "control_push")
        }
        if ("start_ws" in normalized) {
            prefs.websocketRecoveryRequested = true
        }
        if ("stop_ws" in normalized) {
            prefs.websocketRecoveryRequested = false
        }
        applyWebSocketPolicy(app)
    }

    fun applyWebSocketPolicy(context: Context) {
        val prefs = Prefs(context)
        val wanted = prefs.alertTransport == "websocket" || prefs.websocketRecoveryRequested
        if (wanted) {
            AlertService.start(context, if (prefs.alertTransport == "websocket") "primary" else "recovery")
        } else {
            AlertService.stop(context, "fcm_primary_healthy")
        }
    }
}
