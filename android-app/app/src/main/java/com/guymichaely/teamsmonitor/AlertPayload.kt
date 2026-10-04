package com.guymichaely.teamsmonitor

import org.json.JSONObject

data class AlertPayload(val title: String, val body: String, val time: String)

/** Parses established Teams alerts and explicit generic notification wire formats. */
object AlertPayloadParser {
    fun fromFcm(data: Map<String, String>): AlertPayload? = parse(data)

    fun fromWebSocket(json: JSONObject): AlertPayload? {
        val values = mutableMapOf<String, Any?>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            values[key] = json.opt(key)
        }
        return parse(values)
    }

    private fun parse(data: Map<String, *>): AlertPayload? {
        fun string(name: String): String? = data[name] as? String
        val time = when {
            !data.containsKey("time") || data["time"] == JSONObject.NULL -> ""
            data["time"] is String -> data["time"] as String
            else -> return null
        }
        return when (string("kind")) {
            "notification" -> {
                val title = string("title")?.takeIf { it.isNotBlank() } ?: return null
                val body = string("body")?.takeIf { it.isNotBlank() } ?: return null
                if (title.toByteArray(Charsets.UTF_8).size > MAX_TITLE_BYTES) return null
                if (body.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) return null
                AlertPayload(title, body, time)
            }
            "alert" -> {
                val chat = string("chat") ?: return null
                val author = string("author") ?: return null
                val body = string("text") ?: return null
                AlertPayload("$author · $chat", body, time)
            }
            else -> null
        }
    }

    private const val MAX_TITLE_BYTES = 256
    private const val MAX_BODY_BYTES = 3000
}
