package com.smsmirror.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * File d'attente locale pour les messages qui n'ont pas pu être envoyés.
 * Ils seront réessayés au prochain cycle de synchronisation.
 */
object PendingQueue {

    private const val KEY = "pending_messages"
    private const val MAX_QUEUE_SIZE = 500

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences("sms_mirror_queue", Context.MODE_PRIVATE)

    fun add(context: Context, payload: MessagePayload) {
        val p = prefs(context)
        val existing = JSONArray(p.getString(KEY, "[]") ?: "[]")
        if (existing.length() >= MAX_QUEUE_SIZE) return // Éviter débordement

        val obj = JSONObject().apply {
            put("id", payload.id)
            put("type", payload.type)
            put("sender", payload.sender)
            put("sender_name", payload.senderName)
            put("content", payload.content)
            put("app_name", payload.appName)
            put("app_package", payload.appPackage)
            put("call_type", payload.callType)
            put("call_duration", payload.callDuration)
            put("timestamp", payload.timestamp)
        }
        existing.put(obj)
        p.edit().putString(KEY, existing.toString()).apply()
    }

    fun getAll(context: Context): List<MessagePayload> {
        val p = prefs(context)
        val array = JSONArray(p.getString(KEY, "[]") ?: "[]")
        val result = mutableListOf<MessagePayload>()
        for (i in 0 until array.length()) {
            val obj = array.getJSONObject(i)
            result.add(MessagePayload(
                id          = obj.optString("id"),
                type        = obj.optString("type", "sms"),
                sender      = obj.optString("sender").ifBlank { null },
                senderName  = obj.optString("sender_name").ifBlank { null },
                content     = obj.optString("content").ifBlank { null },
                appName     = obj.optString("app_name").ifBlank { null },
                appPackage  = obj.optString("app_package").ifBlank { null },
                callType    = obj.optString("call_type").ifBlank { null },
                callDuration= obj.optInt("call_duration", 0).takeIf { it > 0 },
                timestamp   = obj.optLong("timestamp", System.currentTimeMillis())
            ))
        }
        return result
    }

    fun clear(context: Context) {
        prefs(context).edit().putString(KEY, "[]").apply()
    }

    fun size(context: Context): Int {
        return JSONArray(prefs(context).getString(KEY, "[]") ?: "[]").length()
    }
}
