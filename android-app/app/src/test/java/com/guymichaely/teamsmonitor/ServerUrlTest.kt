package com.guymichaely.teamsmonitor

import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {
    @Test fun repairsSchemeLessAddressesBeforeBuildingControlAndRegistrationRequests() {
        val base = ServerUrl.normalize("  gui.guymichaely.com/  ")!!
        assertEquals("https://gui.guymichaely.com", base)
        for (path in listOf("/api/control/sync", "/api/fcm/register")) {
            assertEquals("https", Request.Builder().url(base + path).build().url.scheme)
        }
        assertEquals("https://gui.guymichaely.com", ServerUrl.normalize("HTTPS://GUI.GUYMICHAELY.COM/"))
        assertEquals("https://localhost:8090", ServerUrl.normalize("localhost:8090"))
        assertEquals("https://[::1]:8090", ServerUrl.normalize("[::1]:8090"))
        assertEquals("https://gui.guymichaely.com/base", ServerUrl.normalize("//gui.guymichaely.com/base/"))
    }

    @Test fun rejectsInvalidInputWithoutThrowing() {
        for (input in listOf("", "   ", "/relative/path", "https://", "https:///", "http://gui.guymichaely.com",
            "ftp://gui.guymichaely.com", "javascript:alert(1)", "https:gui.guymichaely.com",
            "gui.guymichaely.com:wrong", "bad host", "gui.guymichaely.com\nextra",
            "https://user:password@gui.guymichaely.com", "gui.guymichaely.com?token=h",
            "gui.guymichaely.com#fragment", "https://gui.guymichaely.com\\path")) {
            assertNull(input, ServerUrl.normalize(input))
        }
    }
}
