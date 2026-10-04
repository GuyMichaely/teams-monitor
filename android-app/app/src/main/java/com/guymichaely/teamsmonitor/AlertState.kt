package com.guymichaely.teamsmonitor

import android.content.Context
import android.content.Intent

/**
 * Shared status written by AlertService, read by MainActivity. Same process,
 * so plain @Volatile fields; an app-internal broadcast nudges the UI to refresh.
 */
object AlertState {

    const val ACTION_STATUS = "com.guymichaely.teamsmonitor.STATUS"

    enum class Connection { DISCONNECTED, CONNECTING, RECONNECTING, CONNECTED }

    @Volatile var connection = Connection.DISCONNECTED
        private set
    @Volatile var lastAlertTitle: String? = null
        private set
    @Volatile var lastAlertBody: String? = null
        private set
    @Volatile var lastAlertAt: String? = null
        private set

    fun onConnection(context: Context, state: Connection) {
        connection = state
        broadcast(context)
    }

    fun onAlert(context: Context, title: String, body: String, at: String) {
        lastAlertTitle = title
        lastAlertBody = body
        lastAlertAt = at
        broadcast(context)
    }

    private fun broadcast(context: Context) {
        context.sendBroadcast(Intent(ACTION_STATUS).setPackage(context.packageName))
    }
}
