package com.smsmirror.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.CallLog
import android.provider.Telephony
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import java.util.UUID

/**
 * Service de synchronisation en arrière-plan.
 * — Synchronise l'historique SMS (messages passés non encore envoyés)
 * — Synchronise le journal d'appels
 * — Ré-essaie les messages en attente (PendingQueue)
 * — Tourne toutes les 30 secondes
 */
class SyncService : Service() {

    companion object {
        const val CHANNEL_ID = "sms_mirror_service"
        const val NOTIF_ID = 1001
        const val ACTION_START = "START"
        const val ACTION_STOP = "STOP"

        var isRunning = false

        fun start(context: Context) {
            val intent = Intent(context, SyncService::class.java).apply { action = ACTION_START }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, SyncService::class.java).apply { action = ACTION_STOP })
        }
    }

    private lateinit var settings: SettingsManager
    private lateinit var api: ApiClient
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var syncJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        settings = SettingsManager(this)
        api = ApiClient(settings)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                startForeground(NOTIF_ID, buildNotification("Synchronisation active…"))
                isRunning = true
                startSyncLoop()
            }
        }
        return START_STICKY
    }

    private fun startSyncLoop() {
        syncJob?.cancel()
        syncJob = scope.launch {
            try {
                // Première sync immédiate
                performFullSync()
            } catch (e: SecurityException) {
                Log.e("SyncService", "Permission refusée lors de la sync initiale: ${e.message}")
            } catch (e: Exception) {
                Log.e("SyncService", "Erreur sync initiale: ${e.message}")
            }

            while (isActive) {
                delay(30_000L)  // toutes les 30 secondes
                try {
                    performSync()
                } catch (e: SecurityException) {
                    Log.e("SyncService", "Permission refusée lors de la sync: ${e.message}")
                } catch (e: Exception) {
                    Log.e("SyncService", "Erreur sync périodique: ${e.message}")
                }
            }
        }
    }

    /** Synchronisation complète (au premier démarrage) — historique SMS + appels */
    private suspend fun performFullSync() {
        Log.i("SyncService", "Synchronisation complète…")
        api.registerDevice()
        syncSmsHistory()
        syncCallLog()
        retryPending()
        updateNotification("Synchronisé — ${formatTime()}")
    }

    /** Synchronisation légère (périodique) */
    private suspend fun performSync() {
        if (!settings.isConfigured) return
        syncNewSms()
        syncCallLog()
        retryPending()
        updateNotification("Dernière sync: ${formatTime()}")
    }

    // ─── SMS : historique complet (premier démarrage) ─────────────────────────
    private suspend fun syncSmsHistory() = withContext(Dispatchers.IO) {
        val lastId = settings.lastSmsSyncId
        val cursor: Cursor? = contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY,
                    Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.PERSON),
            if (lastId > 0) "${Telephony.Sms._ID} > ?" else null,
            if (lastId > 0) arrayOf(lastId.toString()) else null,
            "${Telephony.Sms.DATE} ASC LIMIT 500"
        )

        val messages = mutableListOf<MessagePayload>()
        var maxId = lastId

        cursor?.use {
            val idCol   = it.getColumnIndex(Telephony.Sms._ID)
            val addrCol = it.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyCol = it.getColumnIndex(Telephony.Sms.BODY)
            val dateCol = it.getColumnIndex(Telephony.Sms.DATE)

            while (it.moveToNext()) {
                val id      = it.getLong(idCol)
                val address = it.getString(addrCol) ?: continue
                val body    = it.getString(bodyCol) ?: ""
                val date    = it.getLong(dateCol)
                val name    = ContactResolver.getName(this@SyncService, address)

                messages.add(MessagePayload(
                    id          = "sms_$id",
                    type        = "sms",
                    sender      = address,
                    senderName  = name,
                    content     = body,
                    timestamp   = date
                ))

                if (id > maxId) maxId = id
            }
        }

        if (messages.isNotEmpty()) {
            api.sendMessages(messages).onSuccess {
                settings.lastSmsSyncId = maxId
                Log.i("SyncService", "SMS historique: $it envoyés")
            }
        }
    }

    // ─── SMS : nouveaux seulement (sync périodique) ───────────────────────────
    private suspend fun syncNewSms() = withContext(Dispatchers.IO) {
        val lastId = settings.lastSmsSyncId
        if (lastId <= 0) { syncSmsHistory(); return@withContext }
        syncSmsHistory()
    }

    // ─── Journal d'appels ─────────────────────────────────────────────────────
    private suspend fun syncCallLog() = withContext(Dispatchers.IO) {
        val lastId = settings.lastCallSyncId

        val cursor: Cursor? = contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE),
            if (lastId > 0) "${CallLog.Calls._ID} > ?" else null,
            if (lastId > 0) arrayOf(lastId.toString()) else null,
            "${CallLog.Calls.DATE} ASC LIMIT 200"
        )

        val messages = mutableListOf<MessagePayload>()
        var maxId = lastId

        cursor?.use {
            val idCol       = it.getColumnIndex(CallLog.Calls._ID)
            val numberCol   = it.getColumnIndex(CallLog.Calls.NUMBER)
            val nameCol     = it.getColumnIndex(CallLog.Calls.CACHED_NAME)
            val dateCol     = it.getColumnIndex(CallLog.Calls.DATE)
            val durationCol = it.getColumnIndex(CallLog.Calls.DURATION)
            val typeCol     = it.getColumnIndex(CallLog.Calls.TYPE)

            while (it.moveToNext()) {
                val id       = it.getLong(idCol)
                val number   = it.getString(numberCol) ?: "Inconnu"
                val name     = it.getString(nameCol)?.takeIf { n -> n.isNotBlank() }
                               ?: ContactResolver.getName(this@SyncService, number)
                val date     = it.getLong(dateCol)
                val duration = it.getInt(durationCol)
                val callType = when (it.getInt(typeCol)) {
                    CallLog.Calls.INCOMING_TYPE  -> "INCOMING"
                    CallLog.Calls.OUTGOING_TYPE  -> "OUTGOING"
                    CallLog.Calls.MISSED_TYPE    -> "MISSED"
                    CallLog.Calls.REJECTED_TYPE  -> "MISSED"
                    else -> "UNKNOWN"
                }

                messages.add(MessagePayload(
                    id           = "call_$id",
                    type         = "call",
                    sender       = number,
                    senderName   = name,
                    content      = null,
                    callType     = callType,
                    callDuration = duration,
                    timestamp    = date
                ))

                if (id > maxId) maxId = id
            }
        }

        if (messages.isNotEmpty()) {
            api.sendMessages(messages).onSuccess {
                settings.lastCallSyncId = maxId
                Log.i("SyncService", "Appels: $it envoyés")
            }
        }
    }

    // ─── Retry queue ──────────────────────────────────────────────────────────
    private suspend fun retryPending() {
        val pending = PendingQueue.getAll(this)
        if (pending.isEmpty()) return
        api.sendMessages(pending).onSuccess {
            PendingQueue.clear(this)
            Log.i("SyncService", "Queue: $it messages réessayés avec succès")
        }
    }

    // ─── Notification ─────────────────────────────────────────────────────────
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_desc)
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val intent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_send)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setContentIntent(intent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    override fun onDestroy() {
        scope.cancel()
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun formatTime(): String {
        val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
        return sdf.format(java.util.Date())
    }
}
