package com.guymichaely.teamsmonitor

/** Redact credentials without replacing short token fragments inside ordinary words. */
object DiagnosticsRedaction {
    fun redact(value: String, token: String = ""): String {
        val scrubbed = value
            .replace(Regex("(?i)((?:access_token|token)=)[^&\\s]+"), "$1<redacted>")
            .replace(Regex("(?i)(authorization:\\s*bearer\\s+)[^\\s]+"), "$1<redacted>")
        if (token.isBlank()) return scrubbed
        if (token.length >= 8) return scrubbed.replace(token, "<redacted>")
        val standalone = Regex("(?<![\\p{L}\\p{N}_])${Regex.escape(token)}(?![\\p{L}\\p{N}_])")
        return scrubbed.replace(standalone, "<redacted>")
    }
}
