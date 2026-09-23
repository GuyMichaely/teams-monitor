package com.guymichaely.teamsmonitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DiagnosticsFilterTest {
    private val now = Instant.parse("2026-09-23T12:00:00Z")
    private fun line(at: String, event: String, details: String = "") = "$at | $event | $details"

    @Test fun defaultWindowIncludesBoundaryAndExcludesOldAndFutureEvents() {
        val boundary = line("2026-09-23T11:00:00Z", "alert_received")
        val result = DiagnosticsFilter().select(listOf(
            line("2026-09-23T10:59:59Z", "alert_received"), boundary,
            line("2026-09-23T12:00:01Z", "alert_received")
        ).joinToString("\n"), now)
        assertEquals(listOf(boundary), result.lines)
        assertEquals(3, result.retainedCount)
    }

    @Test fun customRangeIncludesBothExactBounds() {
        val start = line("2026-09-23T10:00:00Z", "at_start")
        val middle = line("2026-09-23T10:30:00Z", "inside")
        val end = line("2026-09-23T11:00:00Z", "at_end")
        val before = line("2026-09-23T09:59:59.999Z", "before")
        val after = line("2026-09-23T11:00:00.001Z", "after")
        val result = DiagnosticsFilter(
            windowMs = null,
            rangeStartMs = Instant.parse("2026-09-23T10:00:00Z").toEpochMilli(),
            rangeEndMs = Instant.parse("2026-09-23T11:00:00Z").toEpochMilli()
        ).select(listOf(before, start, middle, end, after).joinToString("\n"), now)
        assertEquals(listOf(start, middle, end), result.lines)
    }

    @Test fun customRangeRejectsReversedOrIncompleteBounds() {
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            DiagnosticsFilter(windowMs = null, rangeStartMs = 2L, rangeEndMs = 1L).select("", now)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            DiagnosticsFilter(windowMs = null, rangeStartMs = 1L).select("", now)
        }
    }

    @Test fun categoryAndSearchCombineCaseInsensitively() {
        val alert = line("2026-09-23T11:30:00Z", "fcm_message_received", "chat=Example alertId=ABC")
        val connected = line("2026-09-23T11:30:01Z", "ws_connected", "chat=Example")
        val result = DiagnosticsFilter(category = DiagnosticsFilter.Category.ALERTS, query = " example ")
            .select("$alert\n$connected", now)
        assertEquals(listOf(alert), result.lines)
        assertTrue(DiagnosticsFilter(query = "does-not-exist").select(alert, now).lines.isEmpty())
    }

    @Test fun connectionAndErrorCategoriesMatchEventNamesAndErrorDetails() {
        val connected = line("2026-09-23T11:30:00Z", "ws_connected")
        val failed = line("2026-09-23T11:30:01Z", "fcm_sync_failed", "error=offline")
        val detail = line("2026-09-23T11:30:02Z", "other_event", "error=problem")
        val log = "$connected\n$failed\n$detail"
        assertEquals(listOf(connected, failed), DiagnosticsFilter(category = DiagnosticsFilter.Category.CONNECTIONS).select(log, now).lines)
        assertEquals(listOf(failed, detail), DiagnosticsFilter(category = DiagnosticsFilter.Category.ERRORS).select(log, now).lines)
    }

    @Test fun timeLimitedExportsExcludeUnparseableLinesButAllRetainedIncludesThem() {
        val log = "bad timestamp | unknown | detail\n\n"
        val limited = DiagnosticsFilter().select(log, now)
        assertEquals(1, limited.unparseableCount)
        assertTrue(limited.lines.isEmpty())
        assertEquals(1, DiagnosticsFilter(windowMs = null).select(log, now).lines.size)
    }

    @Test fun exportCapKeepsNewestWholeLinesAndReportsOmissions() {
        val older = line("2026-09-23T11:01:00Z", "alert_received", "older")
        val newer = line("2026-09-23T11:02:00Z", "alert_received", "newer")
        val result = DiagnosticsFilter().select("$older\n$newer", now, newer.length + 1)
        assertEquals(listOf(newer), result.lines)
        assertEquals(2, result.matchedCount)
        assertEquals(1, result.omittedCount)
        assertTrue(DiagnosticsFilter().select(newer, now, 0).lines.isEmpty())
    }

    @Test fun emptyLogHasZeroCounts() {
        val result = DiagnosticsFilter().select("\n", now)
        assertEquals(0, result.retainedCount)
        assertEquals(0, result.matchedCount)
        assertEquals(0, result.omittedCount)
    }
}
