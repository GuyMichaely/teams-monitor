package com.guymichaely.teamsmonitor

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

object DiagnosticsExport {
    fun shareIntent(context: Context, report: String): Intent {
        val directory = File(context.cacheDir, "diagnostics").apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        // Only exported diagnostics are exposed. Never grant access to app files or preferences.
        val existing = directory.listFiles().orEmpty().filter {
            it.isFile && it.name.startsWith("teams-monitor-diagnostics-") && it.extension == "txt"
        }.sortedByDescending { it.lastModified() }
        existing.forEachIndexed { index, file ->
            if (index >= 19 || file.lastModified() < cutoff) file.delete()
        }
        val stamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC).format(Instant.now())
        val file = File(directory, "teams-monitor-diagnostics-$stamp-${UUID.randomUUID()}.txt")
        file.writeText(report)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.diagnostics", file)
        return Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, "Teams Monitor diagnostics")
            clipData = ClipData.newUri(context.contentResolver, "Teams Monitor diagnostics", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }
}
