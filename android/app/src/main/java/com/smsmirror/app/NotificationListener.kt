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

        // Extraction ROBUSTE du texte : certaines apps (ex. Wave perso) ne remplissent
        // pas "android.text". On couvre BigText, InboxStyle (textLines),
        // MessagingStyle (messages), sous-titres, puis un balayage de tous les extras.
        fun ex(key: String) = extras.getCharSequence(key)?.toString()?.trim().orEmpty()

        val title = ex("android.title")
        var text = ex("android.bigText")
        if (text.isBlank()) text = ex("android.text")
        if (text.isBlank()) text = ex("android.summaryText")
        if (text.isBlank()) text = ex("android.subText")
        if (text.isBlank()) text = ex("android.infoText")

        if (text.isBlank()) {
            val lines = extras.getCharSequenceArray("android.textLines")
            if (lines != null && lines.isNotEmpty())
                text = lines.joinToString(" | ") { it.toString().trim() }.trim()
        }
        if (text.isBlank()) {
            try {
                val msgs = extras.getParcelableArray("android.messages")
                if (msgs != null && msgs.isNotEmpty())
                    text = msgs.mapNotNull { (it as? android.os.Bundle)?.getCharSequence("text")?.toString()?.trim() }
                        .filter { it.isNotBlank() }.joinToString(" | ")
            } catch (e: Exception) { /* ignore */ }
        }
        // Dernier recours : parcourir toutes les clés extras, prendre le texte le plus long
        if (title.isBlank() && text.isBlank()) {
            var best = ""
            for (key in extras.keySet()) {
                if (key.contains("icon", ignoreCase = true) || key.contains("template", ignoreCase = true)) continue
                val v = extras.get(key)
                val s = when (v) {
                    is CharSequence -> v.toString()
                    is Array<*>     -> v.filterIsInstance<CharSequence>().joinToString(" | ")
                    else            -> ""
                }.trim()
                if (s.length > best.length) best = s
            }
            if (best.isNotBlank()) text = best
        }
        // Ticker en tout dernier recours
        if (title.isBlank() && text.isBlank()) {
            val ticker = notification.tickerText?.toString()?.trim().orEmpty()
            if (ticker.isNotBlank()) text = ticker
        }

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
                    // Supprimer les notifications Wave (perso ET business) après envoi réussi
                    if (appName.contains("wave", ignoreCase = true)) {
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
