package com.guymichaely.teamsmonitor

import android.content.Context
import org.json.JSONArray

object AlertDeduper {
    private const val PREFS = "alert_dedupe"
    private const val KEY = "recent_alert_ids"
    private const val MAX_IDS = 100

    @Synchronized
    fun shouldHandle(context: Context, alertId: String): Boolean {
        val id = alertId.trim()
        if (id.isBlank()) return true

        val sp = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val recent = mutableListOf<String>()
        runCatching {
            val a = JSONArray(sp.getString(KEY, "[]") ?: "[]")
            for (i in 0 until a.length()) {
                val value = a.optString(i)
                if (value.isNotBlank()) recent.add(value)
            }
        }

        if (recent.contains(id)) return false
        recent.add(id)
        while (recent.size > MAX_IDS) recent.removeAt(0)

        val out = JSONArray()
        recent.forEach { out.put(it) }
        sp.edit().putString(KEY, out.toString()).apply()
        return true
    }
}
