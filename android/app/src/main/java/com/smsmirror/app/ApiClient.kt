package com.smsmirror.app

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Client HTTP pour communiquer avec le serveur SMS Mirror.
 */
class ApiClient(private val settings: SettingsManager) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    /**
     * Enregistre l'appareil auprès du serveur.
     */
    suspend fun registerDevice(): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply {
                put("device_id", settings.deviceId)
                put("name", settings.deviceName)
                put("platform", "android")
            }
            val request = Request.Builder()
                .url("${settings.serverUrl}/api/device/register")
                .addHeader("x-device-token", settings.deviceToken)
                .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            val response = client.newCall(request).execute()
            if (response.isSuccessful) Result.success(Unit)
            else Result.failure(Exception("Erreur ${response.code}: ${response.message}"))
        } catch (e: Exception) {
            Log.e("ApiClient", "registerDevice: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Envoie une liste de messages au serveur.
     */
    suspend fun sendMessages(messages: List<MessagePayload>): Result<Int> = withContext(Dispatchers.IO) {
        if (messages.isEmpty()) return@withContext Result.success(0)
        try {
            val array = JSONArray()
            messages.forEach { msg ->
                array.put(JSONObject().apply {
                    put("id", msg.id)
                    put("device_id", settings.deviceId)
                    put("device_name", settings.deviceName)
                    put("type", msg.type)
                    put("sender", msg.sender)
                    put("sender_name", msg.senderName)
                    put("content", msg.content)
                    put("app_name", msg.appName)
                    put("app_package", msg.appPackage)
                    put("call_type", msg.callType)
                    put("call_duration", msg.callDuration)
                    put("timestamp", msg.timestamp)
                })
            }

            val request = Request.Builder()
                .url("${settings.serverUrl}/api/messages")
                .addHeader("x-device-token", settings.deviceToken)
                .post(array.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                val json = JSONObject(response.body?.string() ?: "{}")
                Result.success(json.optInt("inserted", 0))
            } else {
                Result.failure(Exception("Erreur ${response.code}"))
            }
        } catch (e: Exception) {
            Log.e("ApiClient", "sendMessages: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Teste la connexion au serveur.
     */
    suspend fun testConnection(): Result<String> = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("${settings.serverUrl}/api/config")
                .addHeader("x-device-token", settings.deviceToken)
                .get()
                .build()
            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                Result.success("Connexion réussie ✅ (${response.code})")
            } else {
                Result.failure(Exception("Erreur ${response.code}: vérifiez l'URL et le token"))
            }
        } catch (e: Exception) {
            Result.failure(Exception("Impossible de joindre le serveur: ${e.message}"))
        }
    }
}

/**
 * Données d'un message à envoyer.
 */
data class MessagePayload(
    val id: String,
    val type: String,           // "sms", "notification", "call"
    val sender: String?,
    val senderName: String?,
    val content: String?,
    val appName: String? = null,
    val appPackage: String? = null,
    val callType: String? = null,
    val callDuration: Int? = null,
    val timestamp: Long
)
