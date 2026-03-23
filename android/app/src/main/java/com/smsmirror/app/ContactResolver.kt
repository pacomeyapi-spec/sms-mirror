package com.smsmirror.app

import android.content.Context
import android.provider.ContactsContract

/**
 * Résout un numéro de téléphone en nom de contact.
 */
object ContactResolver {

    fun getName(context: Context, phoneNumber: String): String {
        return try {
            val uri = android.net.Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                android.net.Uri.encode(phoneNumber)
            )
            val cursor = context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                null, null, null
            )
            cursor?.use {
                if (it.moveToFirst()) {
                    it.getString(0) ?: phoneNumber
                } else phoneNumber
            } ?: phoneNumber
        } catch (e: Exception) {
            phoneNumber
        }
    }
}
