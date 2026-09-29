package com.guymichaely.teamsmonitor

/** Delivery roles and observed state are separate; FCM has no app-owned socket. */
object DeliveryStatus {
    fun render(primary: String, fallback: String, websocketWanted: Boolean,
               connection: String, fidPresent: Boolean, syncPending: Boolean,
               registration: String): String {
        val fallbackLabel = when (fallback) {
            "none" -> "fallback off"
            "fcm" -> "FCM fallback"
            "websocket" -> "WebSocket fallback"
            else -> "fallback settings not synced"
        }
        val wsRole = when {
            primary == "websocket" -> "primary"
            websocketWanted -> "fallback active"
            fallback == "websocket" -> "standby"
            fallback == "none" -> "disabled"
            else -> "policy not synced"
        }
        val wsState = if (primary == "websocket" || websocketWanted || connection != "disconnected")
            "$wsRole · $connection" else wsRole
        val fcmRole = when {
            primary == "fcm" -> "primary"
            fallback == "fcm" -> "fallback"
            fallback == "unknown" -> "role not synced"
            else -> "control only"
        }
        val fcmState = when {
            !fidPresent -> "not registered"
            syncPending -> "registration sync pending"
            registration == "suspect" -> "registration needs recovery"
            registration == "synced" -> "registration synced"
            else -> "registered on phone · server status unconfirmed"
        }
        return "Alerts: ${if (primary == "fcm") "FCM" else "WebSocket"} primary · $fallbackLabel\n" +
            "WebSocket: $wsState\nFCM: $fcmRole · $fcmState"
    }
}
