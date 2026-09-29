package com.guymichaely.teamsmonitor

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerUrl {
    fun normalize(raw: String): String? {
        val input = raw.trim()
        if (input.isEmpty() || input.any { it.isWhitespace() || it.isISOControl() } || '\\' in input) return null
        val candidate = when {
            input.startsWith("https://", ignoreCase = true) -> input
            input.startsWith("//") -> "https:$input"
            input.startsWith('/') || "://" in input ||
                (input.matches(Regex("^[A-Za-z][A-Za-z0-9+.-]*:.*")) &&
                    !input.matches(Regex("^[^/:]+:[0-9]+(?:/.*)?$"))) -> return null
            else -> "https://$input"
        }
        val url = candidate.toHttpUrlOrNull() ?: return null
        if (url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() ||
            url.query != null || url.fragment != null) return null
        return url.toString().trimEnd('/')
    }
}
