package com.yapson.notifclean

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Balaie les notifications actives à intervalle régulier (1 min par défaut)
 * et efface celles des applications Wave.
 *
 * IMPORTANT — sécurité des données :
 * une notification n'est effacée que si elle est plus vieille que le "délai de
 * sécurité" (60 s par défaut). Cela laisse à SMS Mirror le temps de la capturer
 * et de l'envoyer à YapsonPress avant sa suppression : aucun paiement n'est perdu.
 */
class WaveCleanerService : NotificationListenerService() {

    companion object {
        const val PREFS = "waveclean"
        const val K_ENABLED   = "enabled"        // nettoyage actif
        const val K_INTERVAL  = "interval_sec"   // fréquence du balayage
        const val K_MIN_AGE   = "min_age_sec"    // délai de sécurité avant effacement
        const val K_LAST_RUN  = "last_run"       // horodatage du dernier balayage
        const val K_LAST_CNT  = "last_count"     // effacées au dernier balayage
        const val K_TOTAL     = "total"          // total effacées
        const val K_SEEN      = "last_seen"      // notifications Wave présentes vues
        const val ACTION_SWEEP  = "com.yapson.notifclean.SWEEP"
        const val ACTION_CONFIG = "com.yapson.notifclean.CONFIG"

        const val DEF_INTERVAL = 60
        const val DEF_MIN_AGE  = 60

        /** Une notification Wave ? (Wave perso, Wave Business, toute variante) */
        fun isWave(sbn: StatusBarNotification): Boolean {
            val pkg = sbn.packageName?.lowercase() ?: return false
            if (pkg == "com.yapson.notifclean") return false
            return pkg.contains("wave")
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var connected = false

    private val ticker = object : Runnable {
        override fun run() {
            sweep("auto")
            handler.postDelayed(this, intervalMs())
        }
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_SWEEP  -> sweep("manuel")
                ACTION_CONFIG -> restartTicker()
            }
        }
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun intervalMs(): Long =
        (prefs().getInt(K_INTERVAL, DEF_INTERVAL).coerceAtLeast(10)).toLong() * 1000L
    private fun minAgeMs(): Long =
        (prefs().getInt(K_MIN_AGE, DEF_MIN_AGE).coerceAtLeast(0)).toLong() * 1000L

    override fun onListenerConnected() {
        super.onListenerConnected()
        connected = true
        val filter = IntentFilter().apply {
            addAction(ACTION_SWEEP)
            addAction(ACTION_CONFIG)
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        restartTicker()
        Log.i("WaveClean", "Service connecté — balayage toutes les ${intervalMs() / 1000}s")
    }

    override fun onListenerDisconnected() {
        connected = false
        handler.removeCallbacks(ticker)
        try { unregisterReceiver(receiver) } catch (e: Exception) { }
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        try { unregisterReceiver(receiver) } catch (e: Exception) { }
        super.onDestroy()
    }

    private fun restartTicker() {
        handler.removeCallbacks(ticker)
        handler.postDelayed(ticker, 1500)   // premier passage peu après la connexion
    }

    /** Balaie les notifications actives et efface les notifications Wave éligibles. */
    private fun sweep(origine: String) {
        if (!connected) return
        val p = prefs()
        if (!p.getBoolean(K_ENABLED, true)) return

        val minAge = minAgeMs()
        val now = System.currentTimeMillis()
        var efface = 0
        var vues = 0

        try {
            val actives: Array<StatusBarNotification> = activeNotifications ?: return
            for (sbn in actives) {
                if (!isWave(sbn)) continue
                vues++
                if (now - sbn.postTime < minAge) continue   // trop récente : on laisse SMS Mirror la capturer
                try {
                    cancelNotification(sbn.key)
                    efface++
                } catch (e: Exception) {
                    Log.w("WaveClean", "Échec suppression: ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.e("WaveClean", "Balayage impossible: ${e.message}")
            return
        }

        p.edit()
            .putLong(K_LAST_RUN, now)
            .putInt(K_LAST_CNT, efface)
            .putInt(K_SEEN, vues)
            .putInt(K_TOTAL, p.getInt(K_TOTAL, 0) + efface)
            .apply()

        if (efface > 0 || vues > 0)
            Log.i("WaveClean", "Balayage $origine : $vues Wave présente(s), $efface effacée(s)")
    }
}
