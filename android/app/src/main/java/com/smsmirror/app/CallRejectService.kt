package com.smsmirror.app

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log

/**
 * Rejette automatiquement TOUT appel entrant, sans sonnerie, pour ne pas
 * perturber la capture des SMS et des notifications.
 * Nécessite le rôle "filtrage des appels" (ROLE_CALL_SCREENING, Android 10+),
 * demandé à l'utilisateur depuis MainActivity.
 */
class CallRejectService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val isIncoming = callDetails.callDirection == Call.Details.DIRECTION_INCOMING
        if (isIncoming) {
            val response = CallResponse.Builder()
                .setDisallowCall(true)   // ne pas laisser passer l'appel
                .setRejectCall(true)     // raccrocher immédiatement
                .setSkipNotification(true)
                .build()
            respondToCall(callDetails, response)
            Log.i("CallReject", "Appel entrant rejeté automatiquement")
        } else {
            // Appels sortants : ne rien bloquer
            respondToCall(callDetails, CallResponse.Builder().build())
        }
    }
}
