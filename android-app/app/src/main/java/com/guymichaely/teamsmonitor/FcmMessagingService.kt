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
            if (incident == "pc_heartbeat") {
                HealthIncidentManager.handleHeartbeat(
                    this,
                    status = status,
                    at = data["at"],
                    source = "fcm"
                )
            }
            return
        }

        if (kind != "alert") {
            AppLog.event(this, "fcm_message_ignored", "kind=$kind messageId=${message.messageId ?: ""}")
            return
        }

        // Apply transport metadata even if this alertId is a duplicate. During
        // fallback the alternate may alarm first and the duplicate FCM copy can
        // be the successful primary recovery test that tells us to stop WS.
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
