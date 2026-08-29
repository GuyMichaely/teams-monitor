package com.guymichaely.teamsmonitor

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmMessagingService : FirebaseMessagingService() {

    override fun onRegistered(installationId: String) {
        AppLog.event(this, "fcm_on_registered", "fidLength=${installationId.length}")
        FcmRegistration.onRegistered(this, installationId)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val kind = data["kind"].orEmpty().ifBlank { "alert" }

        if (kind == "control") {
            val actions = data["actions"].orEmpty()
                .split(',')
                .map { it.trim() }
                .filter { it.isNotEmpty() }
            AppLog.event(
                this,
                "fcm_control_received",
                "messageId=${message.messageId ?: ""} actions=${actions.joinToString("|")} priority=${message.priority}"
            )

            // Recovery probes/control messages may also carry current server
            // transport state. Apply it before explicit actions.
            val primary = data["primaryTransport"].orEmpty()
            val websocketWanted = data["websocketWanted"]?.toBooleanStrictOrNull()
            if ((primary == "fcm" || primary == "websocket") && websocketWanted != null) {
                RecoveryControl.applyServerState(
                    this,
                    primaryTransport = primary,
                    websocketWanted = websocketWanted
                )
            }
            RecoveryControl.handleControlMessage(this, actions)

            // A probe is successful only when Android has actually received it.
            // Persist the ACK before network I/O so WorkManager/Worker fallback can
            // retry it if the direct control path is unavailable right now.
            val probeId = data["probeId"].orEmpty().trim()
            if (probeId.isNotBlank()) {
                Prefs(this).fcmProbeAckId = probeId
                AppLog.event(this, "fcm_probe_received", "probeIdLength=${probeId.length}")
                NotificationTransport.sync(this)
                NotificationTransport.scheduleProbeAckRetry(this)
            }
            return
        }

        if (kind == "health") {
            val incident = data["incident"].orEmpty()
            val status = data["status"].orEmpty()
            AppLog.event(
                this,
                "fcm_health_received",
                "messageId=${message.messageId ?: ""} incident=$incident status=$status"
            )
            HealthIncidentManager.handleIncident(
                this,
                incident = incident,
                status = status,
                at = data["at"],
                source = "fcm"
            )
            return
        }

        if (kind != "alert") {
            AppLog.event(this, "fcm_message_ignored", "kind=$kind messageId=${message.messageId ?: ""}")
            return
        }

        // Apply transport metadata even if this alertId is a duplicate. During
        // fallback the alternate may alarm first and the duplicate FCM copy can
        // still carry current transport-control metadata.
        val primary = data["primaryTransport"].orEmpty()
        val websocketWanted = data["websocketWanted"]?.toBooleanStrictOrNull()
        if ((primary == "fcm" || primary == "websocket") && websocketWanted != null) {
            RecoveryControl.applyServerState(
                this,
                primaryTransport = primary,
                websocketWanted = websocketWanted
            )
        }

        val alertId = data["alertId"].orEmpty()
        if (!AlertDeduper.shouldHandle(this, alertId)) {
            AppLog.event(this, "alert_duplicate_ignored", "transport=fcm alertId=$alertId")
            return
        }

        val chat = data["chat"].orEmpty()
        val author = data["author"].orEmpty()
        val text = data["text"].orEmpty()
        val time = data["time"].orEmpty()
        AppLog.event(
            this,
            "fcm_message_received",
            "messageId=${message.messageId ?: ""} alertId=$alertId chat=$chat author=$author serverTime=$time textLength=${text.length} priority=${message.priority}"
        )

        AlertState.onAlert(this, chat, author, text, time)
        AlertNotifier.alert(this, chat, author, text)
    }

    override fun onDeletedMessages() {
        AppLog.event(this, "fcm_messages_deleted")
    }
}
