package com.guymichaely.teamsmonitor

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeliveryStatusTest {
    @Test fun fcmWithoutFallbackDisablesWebsocket() {
        val text = DeliveryStatus.render("fcm", "none", false, "disconnected", true, false, "synced")
        assertTrue(text.contains("fallback off"))
        assertTrue(text.contains("WebSocket: disabled"))
        assertTrue(text.contains("FCM: primary · registration synced"))
        assertFalse(text.contains("standby"))
    }

    @Test fun websocketPrimaryStillShowsFcm() {
        for ((fallback, role) in listOf("fcm" to "fallback", "none" to "control only")) {
            val text = DeliveryStatus.render("websocket", fallback, true, "connected", true, false, "synced")
            assertTrue(text.contains("WebSocket: primary · connected"))
            assertTrue(text.contains("FCM: $role · registration synced"))
        }
    }

    @Test fun standbyAndActiveFallbackAreDifferent() {
        assertTrue(DeliveryStatus.render("fcm", "websocket", false, "disconnected", true, false, "synced")
            .contains("WebSocket: standby"))
        assertTrue(DeliveryStatus.render("fcm", "websocket", true, "connecting…", true, false, "suspect")
            .contains("WebSocket: fallback active · connecting…"))
    }

    @Test fun registrationProblemsAndUnknownPolicyStayVisible() {
        assertTrue(DeliveryStatus.render("websocket", "unknown", true, "connected", false, false, "unknown")
            .contains("not registered"))
        assertTrue(DeliveryStatus.render("websocket", "fcm", true, "connected", true, true, "synced")
            .contains("registration sync pending"))
        assertTrue(DeliveryStatus.render("websocket", "fcm", true, "connected", true, false, "suspect")
            .contains("registration needs recovery"))
        val unknown = DeliveryStatus.render("fcm", "unknown", false, "disconnected", true, false, "unknown")
        assertTrue(unknown.contains("fallback settings not synced"))
        assertFalse(unknown.contains("standby"))
        assertFalse(unknown.contains("disabled"))
    }

    @Test fun disabledPolicyDoesNotHideAnExistingConnection() {
        assertTrue(DeliveryStatus.render("fcm", "none", false, "connected", true, false, "synced")
            .contains("WebSocket: disabled · connected"))
    }
}
