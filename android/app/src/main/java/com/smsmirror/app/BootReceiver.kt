package com.smsmirror.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Redémarre le service de synchronisation après le redémarrage du téléphone.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED) {

            val settings = SettingsManager(context)
            if (settings.isConfigured) {
                Log.i("BootReceiver", "Démarrage automatique après reboot")
                SyncService.start(context)
            }
        }
    }
}
