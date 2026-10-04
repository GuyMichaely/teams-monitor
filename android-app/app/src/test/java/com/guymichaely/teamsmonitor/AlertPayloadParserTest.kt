package com.guymichaely.teamsmonitor

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlertPayloadParserTest {
    @Test
    fun parsesSupportedTeamsAlertFromFcmMap() {
        val payload = AlertPayloadParser.fromFcm(
            mapOf("kind" to "alert", "chat" to "Ops", "author" to "Ada", "text" to "Check this", "time" to "now")
        )
        assertEquals(AlertPayload("Ada · Ops", "Check this", "now"), payload)
    }

    @Test
    fun parsesSupportedTeamsAlertFromWebSocketObject() {
        val payload = AlertPayloadParser.fromWebSocket(
            JSONObject("""{"kind":"alert","chat":"Ops","author":"Ada","text":"Check this","time":"now"}""")
        )
        assertEquals(AlertPayload("Ada · Ops", "Check this", "now"), payload)
    }

    @Test
    fun parsesNotificationAndPreservesMultilineBodyWithOptionalTime() {
        val body = "First line\nSecond line"
        val fcm = AlertPayloadParser.fromFcm(
            mapOf("kind" to "notification", "title" to "Build", "body" to body, "time" to "now")
        )
        val websocket = AlertPayloadParser.fromWebSocket(
            JSONObject().put("kind", "notification").put("title", "Build").put("body", body).put("time", "now")
        )
        val withoutTime = AlertPayloadParser.fromWebSocket(
            JSONObject().put("kind", "notification").put("title", "Build").put("body", body)
        )
        assertEquals(AlertPayload("Build", body, "now"), fcm)
        assertEquals(fcm, websocket)
        assertEquals(AlertPayload("Build", body, ""), withoutTime)
    }

    @Test
    fun rejectsMalformedNotificationWithoutTeamsAlertFallback() {
        assertNull(AlertPayloadParser.fromFcm(mapOf(
            "kind" to "notification", "chat" to "Ops", "author" to "Ada", "text" to "Teams text"
        )))
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "notification", "title" to "Build")))
        assertEquals(AlertPayload("Build", "Ready", ""), AlertPayloadParser.fromFcm(
            mapOf("kind" to "notification", "title" to "Build", "body" to "Ready")
        ))
        assertNull(AlertPayloadParser.fromWebSocket(
            JSONObject().put("kind", "notification").put("title", "Build").put("body", 42)
        ))
        assertNull(AlertPayloadParser.fromWebSocket(
            JSONObject().put("kind", "notification").put("title", "Build").put("body", "Ready").put("time", 42)
        ))
        assertEquals(AlertPayload("Build", "Ready", ""), AlertPayloadParser.fromWebSocket(
            JSONObject().put("kind", "notification").put("title", "Build").put("body", "Ready").put("time", JSONObject.NULL)
        ))
    }

    @Test
    fun rejectsMalformedTeamsAlertAndUnknownKinds() {
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "alert", "chat" to "Ops", "text" to "x")))
        assertNull(AlertPayloadParser.fromWebSocket(JSONObject().put("kind", "unexpected")))
        assertNull(AlertPayloadParser.fromFcm(mapOf("chat" to "Ops", "author" to "Ada", "text" to "x")))
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "", "chat" to "Ops", "author" to "Ada", "text" to "x")))
    }

    @Test
    fun rejectsEmptyAndOversizedNotificationFieldsUsingUtf8Bytes() {
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "notification", "title" to " ", "body" to "Ready")))
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "notification", "title" to "Build", "body" to "\n\t")))
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "notification", "title" to "é".repeat(129), "body" to "x")))
        assertNull(AlertPayloadParser.fromFcm(mapOf("kind" to "notification", "title" to "Build", "body" to "é".repeat(1501))))
        assertEquals(AlertPayload("通知", "準備完了", ""), AlertPayloadParser.fromFcm(
            mapOf("kind" to "notification", "title" to "通知", "body" to "準備完了")
        ))
        val ellipsisBody = "…".repeat(1000)
        assertEquals(AlertPayload("Build", ellipsisBody, ""), AlertPayloadParser.fromFcm(
            mapOf("kind" to "notification", "title" to "Build", "body" to ellipsisBody)
        ))
    }
}
