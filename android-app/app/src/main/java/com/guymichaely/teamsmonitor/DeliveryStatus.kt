package com.guymichaely.teamsmonitor

/** Alert roles are policy; socket connectivity and FCM readiness are observations. */
object DeliveryStatus {
    enum class Tone { GOOD, WAITING, ERROR, MUTED }
    data class Part(val text: String, val tone: Tone)

    fun parts(primary: String, fallback: String, websocketWanted: Boolean,
              connection: String, fidPresent: Boolean, syncPending: Boolean,
              registration: String, deliveryState: String = "unknown",
              activeTransport: String = "unknown", fcmAvailable: Boolean = true): List<Part> {
        val wsPrimary = primary == "websocket"
        val wsBackup = !wsPrimary && fallback == "websocket"
        val wsActive = wsBackup && websocketWanted
        val conn = when (connection) {
            "connected" -> "connected"
            "connecting", "connecting…" -> "connecting"
            "reconnecting" -> "reconnecting"
            else -> "disconnected"
        }
        val wsState = when {
            wsPrimary || wsActive -> conn
            // Don't hide a socket that hasn't stopped yet after disabling it.
            conn != "disconnected" -> if (fallback == "unknown") "$conn (role unknown)" else "$conn (stopping)"
            wsBackup -> "standby"
            fallback == "none" -> "off"
            else -> "unknown"
        }
        val wsRole = when {
            wsPrimary -> " (primary)"
            wsActive -> " (backup active)"
            wsBackup -> " (backup)"
            else -> ""
        }
        val wsTone = when {
            wsState == "off" || wsState == "standby" -> Tone.MUTED
            wsState == "disconnected" -> Tone.ERROR
            wsState == "connected" && !wsActive -> Tone.GOOD
            else -> Tone.WAITING
        }
        val ws = Part("WebSocket $wsState$wsRole", wsTone)
        val fcmPrimary = primary == "fcm"
        val fcmBackup = !fcmPrimary && fallback == "fcm"
        val fcmActive = fcmBackup && deliveryState == "fallback" && activeTransport == "fcm"
        val fcmState = when {
            !fcmPrimary && fallback == "none" -> "off"
            !fcmAvailable -> "unavailable"
            registration == "suspect" -> "needs recovery"
            !fidPresent -> "registering"
            syncPending -> "sync pending"
            fcmPrimary && deliveryState == "primary_failed" -> "unavailable"
            fcmPrimary && (deliveryState == "primary_retrying" || deliveryState == "fallback" || wsActive) -> "retrying"
            registration == "synced" -> "ready"
            else -> "unknown"
        }
        val fcmRole = when {
            fcmPrimary -> " (primary)"
            fcmActive -> " (backup active)"
            fcmBackup -> " (backup)"
            fallback != "none" -> " (role unknown)"
            else -> ""
        }
        val fcmTone = when {
            fcmState == "off" -> Tone.MUTED
            fcmState == "needs recovery" || fcmState == "unavailable" -> Tone.ERROR
            fcmState == "ready" && !fcmActive -> Tone.GOOD
            else -> Tone.WAITING
        }
        val fcm = Part("FCM $fcmState$fcmRole", fcmTone)
        return if (fcmPrimary) listOf(fcm, ws) else listOf(ws, fcm)
    }

    fun render(primary: String, fallback: String, websocketWanted: Boolean,
               connection: String, fidPresent: Boolean, syncPending: Boolean,
               registration: String, deliveryState: String = "unknown",
               activeTransport: String = "unknown"): String =
        "Alerts: " + parts(primary, fallback, websocketWanted, connection, fidPresent,
            syncPending, registration, deliveryState, activeTransport).joinToString(" • ") { it.text }
}
