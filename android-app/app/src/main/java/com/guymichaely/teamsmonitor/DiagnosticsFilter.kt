package com.guymichaely.teamsmonitor

import java.time.Instant
import java.time.ZoneId

/** Filters the existing timestamp | event | details format without Android dependencies. */
data class DiagnosticsFilter(
    val windowMs: Long? = 60 * 60 * 1000L,
    val category: Category = Category.ALL,
    val query: String = "",
    val rangeStartMs: Long? = null,
    val rangeEndMs: Long? = null,
    val localZoneId: String = ZoneId.systemDefault().id
) {
    enum class Category { ALL, ALERTS, CONNECTIONS, ERRORS }

    data class Result(
        val lines: List<String>,
        val retainedCount: Int,
        val matchedCount: Int,
        val unparseableCount: Int
    ) {
        val omittedCount: Int get() = matchedCount - lines.size
    }

    fun select(log: String, now: Instant, maxChars: Int = 200_000): Result {
        require(maxChars >= 0)
        require(windowMs == null || windowMs >= 0)
        require((rangeStartMs == null) == (rangeEndMs == null)) { "Custom range requires both bounds" }
        require(rangeStartMs == null || rangeStartMs <= rangeEndMs!!) { "Range start must not be after range end" }
        val retained = log.lineSequence().filter { it.isNotBlank() }.toList()
        var unparseable = 0
        val matches = retained.filter { line ->
            val parts = line.split(" | ", limit = 3)
            val timestamp = runCatching { Instant.parse(parts[0]) }.getOrNull()
            if (timestamp == null) unparseable++
            val event = parts.getOrElse(1) { "" }
            val inWindow = when {
                rangeStartMs != null -> timestamp != null &&
                    !timestamp.isBefore(Instant.ofEpochMilli(rangeStartMs)) &&
                    !timestamp.isAfter(Instant.ofEpochMilli(rangeEndMs!!))
                windowMs == null -> true
                else -> timestamp != null && !timestamp.isBefore(now.minusMillis(windowMs)) && !timestamp.isAfter(now)
            }
            val inCategory = when (category) {
                Category.ALL -> true
                Category.ALERTS -> event.startsWith("alert_") || event.startsWith("alarm_") ||
                    event.startsWith("notification_") || event.startsWith("health_") ||
                    event == "fcm_message_received" || event == "fcm_health_received" || event == "ws_alert_received"
                Category.CONNECTIONS -> event.startsWith("ws_") || event.startsWith("fcm_") ||
                    event.startsWith("control_") || event.startsWith("service_") || event.startsWith("transport_")
                Category.ERRORS -> event.contains("fail") || event.contains("error") ||
                    event.contains("unavailable") || event == "fcm_messages_deleted" ||
                    parts.getOrElse(2) { "" }.contains("error=", ignoreCase = true)
            }
            inWindow && inCategory && line.contains(query.trim(), ignoreCase = true)
        }
        // Keep whole newest entries, bounding clipboard size as well as file exports.
        var chars = 0
        val selected = matches.asReversed().takeWhile { line ->
            (chars + line.length + 1 <= maxChars).also { if (it) chars += line.length + 1 }
        }.asReversed()
        return Result(selected, retained.size, matches.size, unparseable)
    }
}
