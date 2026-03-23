package com.smsmirror.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SmsMessage
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.UUID

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return
        val grouped = mutableMapOf<String, StringBuilder>()
        val firstByAddress = mutableMapOf<String, SmsMessage>()
        messages.forEach { msg ->
            val addr = msg.displayOriginatingAddress ?: "Inconnu"
            grouped.getOrPut(addr) { StringBuilder() }.append(msg.displayMessageBody)
            firstByAddress.getOrPut(addr) { msg }
        }
        val settings = SettingsManager(context)
        if (!settings.isConfigured) return
        val api = ApiClient(settings)
        grouped.forEach { (address, body) ->
            val first = firstByAddress[address]!!
            val senderName = ContactResolver.getName(context, address)
            val payload = MessagePayload(
                id = UUID.randomUUID().toString(),
                type = "sms",
                sender = address,
                senderName = senderName,
                content = body.toString(),
                timestamp = first.timestampMillis.takeIf { it > 0 } ?: System.currentTimeMillis()
            )
            CoroutineScope(Dispatchers.IO).launch {
                api.sendMessages(listOf(payload)).onFailure {
                    PendingQueue.add(context, payload)
                }
            }
        }
    }
}
