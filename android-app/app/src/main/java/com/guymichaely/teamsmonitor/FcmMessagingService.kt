package com.guymichaely.teamsmonitor

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        AppLog.event(this, "fcm_new_token", "tokenLength=${token.length}")
        FcmRegistration.syncToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val chat = data["chat"].orEmpty()
        val author = data["author"].orEmpty()
        val text = data["text"].orEmpty()
        val time = data["time"].orEmpty()
        AppLog.event(
            this,
            "fcm_message_received",
            "messageId=${message.messageId ?: ""} chat=$chat author=$author serverTime=$time textLength=${text.length} priority=${message.priority}"
        )
        AlertState.onAlert(this, chat, author, text, time)
        AlertNotifier.alert(this, chat, author, text)
    }

    override fun onDeletedMessages() {
        AppLog.event(this, "fcm_messages_deleted")
    }
}
