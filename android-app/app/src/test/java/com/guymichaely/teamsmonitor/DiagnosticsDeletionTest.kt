package com.guymichaely.teamsmonitor

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.util.concurrent.Callable
import java.util.concurrent.Executors

class DiagnosticsDeletionTest {
    private val cutoff = Instant.parse("2026-09-28T12:00:00Z")

    @Test fun preservesTimestampOnlyAndEmptyEventRecords() {
        val log = "2026-09-28T11:00:00Z\n2026-09-28T11:00:00Z |  | malformed\n"
        val result = DiagnosticsDeletion.before(log, cutoff)
        assertEquals(0, result.deletedCount)
        assertEquals(2, result.retainedCount)
        assertEquals(0, DiagnosticsDeletion.before("", cutoff).retainedCount)
    }

    @Test fun deletesOnlyStrictlyEarlierParseableRecords() {
        val before = "2026-09-28T11:59:59.999Z | old | any category"
        val exact = "2026-09-28T12:00:00Z | boundary | retained"
        val after = "2026-09-28T12:00:00.001Z | new | retained"
        val malformed = "not-a-time | odd | retained"
        val undated = "legacy unstructured line"
        val result = DiagnosticsDeletion.before(listOf(before, exact, after, malformed, undated).joinToString("\n", postfix = "\n"), cutoff)
        assertEquals(1, result.deletedCount)
        assertEquals(4, result.retainedCount)
        assertEquals(listOf(exact, after, malformed, undated), result.retainedLines)
    }

    @Test fun concurrentSelectionsAreDeterministicAndDoNotMutateInput() {
        val input = (1..1000).joinToString("\n") { index ->
            "${if (index % 2 == 0) "2026-09-28T11:00:00Z" else "2026-09-28T12:00:00Z"} | event_$index"
        }
        val pool = Executors.newFixedThreadPool(8)
        try {
            val results = pool.invokeAll((1..32).map {
                Callable { DiagnosticsDeletion.before(input, cutoff) }
            }).map { it.get() }
            assertEquals(32, results.size)
            results.forEach {
                assertEquals(500, it.deletedCount)
                assertEquals(500, it.retainedCount)
                assertEquals(results.first(), it)
            }
        } finally {
            pool.shutdownNow()
        }
    }
}
