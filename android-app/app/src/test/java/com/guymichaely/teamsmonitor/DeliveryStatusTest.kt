package com.guymichaely.teamsmonitor

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeliveryStatusTest {
    @Test fun fcmWithoutFallbackDisablesWebsocket() {
        val text = DeliveryStatus.render("fcm", "none", false, "disconnected", true, false, "synced")
        assertEquals("Alerts: FCM ready (primary) • WebSocket off", text)
        assertFalse(text.contains("standby"))
    }

    @Test fun websocketPrimaryStillShowsFcm() {
        for ((fallback, expected) in listOf("fcm" to "ready (backup)", "none" to "off")) {
            val text = DeliveryStatus.render("websocket", fallback, true, "connected", true, false, "synced")
            assertEquals("Alerts: WebSocket connected (primary) • FCM $expected", text)
        }
    }

    @Test fun standbyAndActiveFallbackAreDifferent() {
        assertTrue(DeliveryStatus.render("fcm", "websocket", false, "disconnected", true, false, "synced")
            .contains("WebSocket standby (backup)"))
        assertTrue(DeliveryStatus.render("fcm", "websocket", true, "connecting…", true, false, "suspect")
            .contains("WebSocket connecting (backup active)"))
    }

    @Test fun registrationProblemsAndUnknownPolicyStayVisible() {
        assertTrue(DeliveryStatus.render("websocket", "unknown", true, "connected", false, false, "unknown")
            .contains("registering (role unknown)"))
        assertTrue(DeliveryStatus.render("websocket", "fcm", true, "connected", true, true, "synced")
            .contains("sync pending"))
        assertTrue(DeliveryStatus.render("websocket", "fcm", true, "connected", true, false, "suspect")
            .contains("needs recovery"))
        val unknown = DeliveryStatus.render("fcm", "unknown", false, "disconnected", true, false, "unknown")
        assertTrue(unknown.contains("WebSocket unknown"))
        assertTrue(unknown.contains("FCM unknown (primary)"))
        assertFalse(unknown.contains("standby"))
        assertFalse(unknown.contains("off"))
    }

    @Test fun disabledPolicyDoesNotHideAnExistingConnection() {
        assertTrue(DeliveryStatus.render("fcm", "none", false, "connected", true, false, "synced")
            .contains("WebSocket connected (stopping)"))
    }

    @Test fun connectionTransitionsStayVisible() {
        for (state in listOf("connecting", "reconnecting", "disconnected", "connected")) {
            assertEquals("Alerts: WebSocket $state (primary) • FCM off",
                DeliveryStatus.render("websocket", "none", true, state, true, false, "synced"))
        }
    }

    @Test fun runtimeHealthAndBackupRoles() {
        assertEquals("Alerts: FCM retrying (primary) • WebSocket connected (backup active)",
            DeliveryStatus.render("fcm", "websocket", true, "connected", true, false, "synced", "fallback", "websocket"))
        assertEquals("Alerts: WebSocket reconnecting (primary) • FCM ready (backup active)",
            DeliveryStatus.render("websocket", "fcm", true, "reconnecting", true, false, "synced", "fallback", "fcm"))
        assertEquals("Alerts: FCM unavailable (primary) • WebSocket off",
            DeliveryStatus.render("fcm", "none", false, "disconnected", true, false, "synced", "primary_failed", "fcm"))
        assertEquals("Alerts: FCM retrying (primary) • WebSocket off",
            DeliveryStatus.render("fcm", "none", false, "disconnected", true, false, "synced", "primary_retrying", "fcm"))
        // Disabled alert delivery hides irrelevant registration/recovery problems.
        assertEquals("Alerts: WebSocket connected (primary) • FCM off",
            DeliveryStatus.render("websocket", "none", true, "connected", false, true, "suspect", "fallback", "fcm"))
    }

    @Test fun tonesDistinguishIdleFromFailure() {
        val idle = DeliveryStatus.parts("fcm", "websocket", false, "disconnected", true, false, "synced")
        assertEquals(DeliveryStatus.Tone.GOOD, idle[0].tone)
        assertEquals(DeliveryStatus.Tone.MUTED, idle[1].tone)
        val active = DeliveryStatus.parts("fcm", "websocket", true, "connected", true, false, "synced")
        assertEquals(DeliveryStatus.Tone.WAITING, active[0].tone)
        assertEquals(DeliveryStatus.Tone.WAITING, active[1].tone)
        assertEquals(DeliveryStatus.Tone.ERROR,
            DeliveryStatus.parts("websocket", "none", true, "disconnected", false, false, "unknown")[0].tone)
        assertEquals("FCM unavailable (primary)",
            DeliveryStatus.parts("fcm", "none", false, "disconnected", false, false, "unknown", fcmAvailable = false)[0].text)
        assertFalse(DeliveryStatus.render("fcm", "none", false, "disconnected", true, false, "synced").contains("FCM connected"))
    }
}
