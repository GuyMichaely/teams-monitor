package com.guymichaely.teamsmonitor

import java.time.Instant

/** Pure line selection for destructive diagnostics cleanup. */
object DiagnosticsDeletion {
    data class Result(val retainedLines: List<String>, val deletedCount: Int, val retainedCount: Int)

    fun before(log: String, cutoff: Instant): Result {
        val lines = log.lineSequence().toList().let { all -> if (all.lastOrNull() == "") all.dropLast(1) else all }
        var deleted = 0
        val retained = lines.filter { line ->
            val fields = line.split(" | ", limit = 3)
            val timestamp = if (fields.size >= 2 && fields[1].isNotBlank()) {
                runCatching { Instant.parse(fields[0]) }.getOrNull()
            } else null
            val remove = timestamp != null && timestamp.isBefore(cutoff)
            if (remove) deleted++
            !remove
        }
        return Result(retained, deleted, retained.size)
    }
}
