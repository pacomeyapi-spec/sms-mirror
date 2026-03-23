package com.smsmirror.app

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Capture toutes les notifications de l'appareil et les envoie au serveur.
 * Nécessite l'accès aux notifications dans les paramètres système.
 */
class NotificationListener : NotificationListenerService() {

    // Apps à ignorer (éviter les boucles et les notifs inutiles)
    private val IGNORED_PACKAGES = setOf(
        "com.smsmirror.app",
        "android",
        "com.android.systemui",
        "com.android.settings",
        "com.google.android.gms",
        "com.android.packageinstaller",
        "com.android.vending"
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName
        if (pkg in IGNORED_PACKAGES) return

        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return

        val title = extras.getCharSequence("android.title")?.toString() ?: ""
        val text = extras.getCharSequence("android.text")?.toString()
            ?: extras.getCharSequence("android.bigText")?.toString()
            ?: ""

        // Ignorer les notifications vides ou de progression
        if (title.isBlank() && text.isBlank()) return
        if (notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0) return

        val settings = SettingsManager(this)
        if (!settings.isConfigured) return

        val appName = getAppName(pkg)
        val content = when {
            title.isNotBlank() && text.isNotBlank() -> "$title: $text"
            title.isNotBlank() -> title
            else -> text
        }

        val payload = MessagePayload(
            id = "${pkg}_${sbn.id}_${sbn.postTime}",
            type = "notification",
            sender = null,
            senderName = null,
            content = content,
            appName = appName,
            appPackage = pkg,
            timestamp = sbn.postTime
        )

        Log.i("NotifListener", "[$appName] $content")

        val notifKey = sbn.key  // capturer avant le lancement de la coroutine
        CoroutineScope(Dispatchers.IO).launch {
            val api = ApiClient(settings)
            api.sendMessages(listOf(payload))
                .onSuccess {
                    // Supprimer la notification Wave Business après envoi réussi
                    if (appName == "Wave Business") {
                        try {
                            cancelNotification(notifKey)
                        } catch (e: Exception) {
                            Log.w("NotifListener", "Impossible de supprimer la notif: ${e.message}")
                        }
                    }
                }
                .onFailure {
                Log.e("NotifListener", "Échec: ${it.message}")
                PendingQueue.add(applicationContext, payload)
            }
        }
    }

    private fun getAppName(packageName: String): String {
        return try {
            val pm = packageManager
            val info = pm.getApplicationInfo(packageName, 0)
            pm.getApplicationLabel(info).toString()
        } catch (e: Exception) {
            packageName
        }
    }
}
