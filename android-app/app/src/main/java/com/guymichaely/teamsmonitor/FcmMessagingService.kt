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
        val receivedAt = java.time.Instant.now()
        runCatching { Prefs(this).lastFcmReceiptAtMs = receivedAt.toEpochMilli() }
        val sentAtMs = message.sentTime.takeIf { it > 0L }
        val latencyMs = sentAtMs?.let { receivedAt.toEpochMilli() - it }
        val fcmSendStartedAt = data["fcmSendStartedAt"].orEmpty()
        val pcStartedAtMs = runCatching { java.time.Instant.parse(fcmSendStartedAt).toEpochMilli() }.getOrNull()
        val pcToPhoneMs = pcStartedAtMs?.let { receivedAt.toEpochMilli() - it }
        AppLog.event(
            this,
            "fcm_callback_received",
            "alertId=${data["alertId"].orEmpty()} messageId=${message.messageId.orEmpty()} kind=${data["kind"].orEmpty()} " +
                "originalPriority=${message.originalPriority} deliveredPriority=${message.priority} " +
                "sentTime=${sentAtMs?.let { java.time.Instant.ofEpochMilli(it) } ?: "unknown"} receivedAt=$receivedAt " +
                "approxLatencyMs=${latencyMs?.takeIf { it >= 0 } ?: "unknown"} latencyClock=${if (latencyMs == null) "sent_time_unavailable" else if (latencyMs < 0) "negative_clock_skew" else "approximate"} " +
                "fcmSendStartedAt=${fcmSendStartedAt.ifBlank { "unknown" }} approxPcToPhoneLatencyMs=${pcToPhoneMs?.takeIf { it >= 0 } ?: "unknown"} pcPhoneClock=${if (pcToPhoneMs == null) "send_time_unavailable" else if (pcToPhoneMs < 0) "negative_clock_skew" else "approximate_clocks"} " +
                "device=${AppLog.receiptDeviceState(this)}"
        )
        val kind = data["kind"].orEmpty()

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

            val primary = data["primaryTransport"].orEmpty()
            if ("sync_policy" in actions) {
                // Fetch the current policy: a delayed wake-up must not restore old settings.
                NotificationTransport.sync(this)
                return
            }
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
            HealthIncidentManager.handleIncident(
                this,
                incident = incident,
                status = status,
                at = data["at"],
                source = "fcm"
            )
            return
        }

        if (kind != "alert" && kind != "notification") {
            AppLog.event(this, "fcm_message_ignored", "kind=$kind messageId=${message.messageId ?: ""}")
            return
        }

        // Apply transport metadata even if this alertId is a duplicate. During
        // fallback a successful FCM recovery copy can therefore release WS
        // without causing a second alarm.
        val primary = data["primaryTransport"].orEmpty()
        val websocketWanted = data["websocketWanted"]?.toBooleanStrictOrNull()
        if ((primary == "fcm" || primary == "websocket") && websocketWanted != null) {
            RecoveryControl.applyServerState(
                this,
                primaryTransport = primary,
                websocketWanted = websocketWanted
            )
        }

        val payload = AlertPayloadParser.fromFcm(data)
        if (payload == null) {
            AppLog.event(this, "fcm_alert_invalid", "alertId=${data["alertId"].orEmpty()} kind=$kind")
            return
        }

        val alertId = data["alertId"].orEmpty()
        if (!AlertDeduper.shouldHandle(this, alertId)) {
            AppLog.event(this, "alert_duplicate_ignored", "transport=fcm alertId=$alertId")
            return
        }

        AppLog.event(
            this,
            "fcm_message_received",
            "messageId=${message.messageId ?: ""} alertId=$alertId titleLength=${payload.title.length} bodyLength=${payload.body.length} messageTime=${payload.time} priority=${message.priority}"
        )

        AlertState.onAlert(this, payload.title, payload.body, payload.time)
        AlertNotifier.alert(this, payload.title, payload.body, alertId)
    }

    override fun onDeletedMessages() {
        AppLog.event(this, "fcm_messages_deleted")
    }
}
