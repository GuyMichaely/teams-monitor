package com.guymichaely.teamsmonitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class DiagnosticsRedactionTest {
    @Test fun shortTokenDoesNotCorruptWords() {
        assertEquals("history health matched logSearch=<redacted>",
            DiagnosticsRedaction.redact("history health matched logSearch=h", "h"))
    }

    @Test fun queryAndBearerCredentialsAreRemoved() {
        assertEquals("https://example.test/?access_token=<redacted>&x=1 Authorization: Bearer <redacted>",
            DiagnosticsRedaction.redact("https://example.test/?access_token=secret&x=1 Authorization: Bearer abc"))
    }

    @Test fun longKnownTokenIsRemovedEvenFromAnUnstructuredError() {
        assertFalse(DiagnosticsRedaction.redact("error=prefix0123456789suffix", "0123456789").contains("0123456789"))
    }

    @Test fun regexCharactersInTokensAreLiteral() {
        assertEquals("search=<redacted> other", DiagnosticsRedaction.redact("search=a+b other", "a+b"))
    }

    @Test fun emptyTokenDoesNotChangeOrdinaryText() {
        assertEquals("healthy", DiagnosticsRedaction.redact("healthy"))
    }
}
