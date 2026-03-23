package com.smsmirror.app

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * Gère la configuration persistante de l'application.
 */
class SettingsManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("sms_mirror_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(value) = prefs.edit().putString("server_url", value.trimEnd('/')).apply()

    var deviceToken: String
        get() = prefs.getString("device_token", "") ?: ""
        set(value) = prefs.edit().putString("device_token", value).apply()

    var deviceName: String
        get() = prefs.getString("device_name", "Android") ?: "Android"
        set(value) = prefs.edit().putString("device_name", value).apply()

    val deviceId: String
        get() {
            var id = prefs.getString("device_id", null)
            if (id == null) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString("device_id", id).apply()
            }
            return id
        }

    var lastSmsSyncId: Long
        get() = prefs.getLong("last_sms_sync_id", 0L)
        set(value) = prefs.edit().putLong("last_sms_sync_id", value).apply()

    var lastCallSyncId: Long
        get() = prefs.getLong("last_call_sync_id", 0L)
        set(value) = prefs.edit().putLong("last_call_sync_id", value).apply()

    val isConfigured: Boolean
        get() = serverUrl.isNotBlank() && deviceToken.isNotBlank()
}
