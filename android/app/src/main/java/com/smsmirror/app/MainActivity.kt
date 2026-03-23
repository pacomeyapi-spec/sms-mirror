package com.smsmirror.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateFormat
import android.util.Log
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*

class MainActivity : AppCompatActivity() {

    private lateinit var settings: SettingsManager
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Views
    private lateinit var etServerUrl: EditText
    private lateinit var etToken: EditText
    private lateinit var etDeviceName: EditText
    private lateinit var btnSave: Button
    private lateinit var tvPermSms: TextView
    private lateinit var tvPermCall: TextView
    private lateinit var tvPermNotif: TextView
    private lateinit var btnPermissions: Button
    private lateinit var tvStatus: TextView
    private lateinit var tvSyncInfo: TextView
    private lateinit var btnStart: Button
    private lateinit var btnStop: Button
    private lateinit var btnTest: Button
    private lateinit var tvLog: TextView

    private val logLines = ArrayDeque<String>(30)

    companion object {
        private const val PERM_REQUEST_CODE = 100
        private val REQUIRED_PERMISSIONS = arrayOf(
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_CONTACTS,
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        settings = SettingsManager(this)

        // Bind views
        etServerUrl    = findViewById(R.id.etServerUrl)
        etToken        = findViewById(R.id.etToken)
        etDeviceName   = findViewById(R.id.etDeviceName)
        btnSave        = findViewById(R.id.btnSave)
        tvPermSms      = findViewById(R.id.tvPermSms)
        tvPermCall     = findViewById(R.id.tvPermCall)
        tvPermNotif    = findViewById(R.id.tvPermNotif)
        btnPermissions = findViewById(R.id.btnPermissions)
        tvStatus       = findViewById(R.id.tvStatus)
        tvSyncInfo     = findViewById(R.id.tvSyncInfo)
        btnStart       = findViewById(R.id.btnStart)
        btnStop        = findViewById(R.id.btnStop)
        btnTest        = findViewById(R.id.btnTest)
        tvLog          = findViewById(R.id.tvLog)

        // Charger la config
        etServerUrl.setText(settings.serverUrl)
        etToken.setText(settings.deviceToken)
        etDeviceName.setText(settings.deviceName)

        // Boutons
        btnSave.setOnClickListener { saveConfig() }
        btnPermissions.setOnClickListener { requestPermissions() }
        btnStart.setOnClickListener { startSync() }
        btnStop.setOnClickListener { stopSync() }
        btnTest.setOnClickListener { testConnection() }

        updatePermissionStatus()
        updateSyncStatus()
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
        updateSyncStatus()
    }

    private fun saveConfig() {
        val url = etServerUrl.text.toString().trim()
        val token = etToken.text.toString().trim()
        val name = etDeviceName.text.toString().trim()

        if (url.isBlank()) { etServerUrl.error = "URL requise"; return }
        if (token.isBlank()) { etToken.error = "Token requis"; return }

        settings.serverUrl = url
        settings.deviceToken = token
        settings.deviceName = name.ifBlank { "Android" }

        log("✅ Configuration enregistrée")
        Toast.makeText(this, "Configuration enregistrée !", Toast.LENGTH_SHORT).show()
    }

    private fun requestPermissions() {
        // Permissions runtime
        val missing = REQUIRED_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERM_REQUEST_CODE)
        }

        // Accès aux notifications (paramètre système)
        if (!isNotificationAccessEnabled()) {
            log("ℹ️ Activation de l'accès aux notifications requise")
            Toast.makeText(this, "Activez 'SMS Mirror' dans Accès aux notifications", Toast.LENGTH_LONG).show()
            try {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            } catch (e: Exception) {
                Log.e("MainActivity", "Impossible d'ouvrir les paramètres notifications: ${e.message}")
            }
        }

        // Ignorer optimisations batterie
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(android.os.PowerManager::class.java)
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = android.net.Uri.parse("package:$packageName")
                    })
                } catch (e: Exception) {
                    Log.e("MainActivity", "Optimisation batterie non supportée: ${e.message}")
                }
            }
        }
    }

    private fun startSync() {
        if (!settings.isConfigured) {
            Toast.makeText(this, "Configurez d'abord l'URL et le token", Toast.LENGTH_SHORT).show()
            return
        }
        SyncService.start(this)
        log("▶ Service de synchronisation démarré")
        updateSyncStatus()
        Toast.makeText(this, "Synchronisation démarrée !", Toast.LENGTH_SHORT).show()
    }

    private fun stopSync() {
        SyncService.stop(this)
        log("⏹ Service arrêté")
        updateSyncStatus()
    }

    private fun testConnection() {
        if (!settings.isConfigured) {
            Toast.makeText(this, "Configurez d'abord l'URL et le token", Toast.LENGTH_SHORT).show()
            return
        }
        log("🔌 Test de connexion vers ${settings.serverUrl}…")
        btnTest.isEnabled = false

        scope.launch {
            val api = ApiClient(settings)
            val result = api.testConnection()
            withContext(Dispatchers.Main) {
                btnTest.isEnabled = true
                result.onSuccess { msg ->
                    log("✅ $msg")
                    Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
                }.onFailure { e ->
                    log("❌ Échec: ${e.message}")
                    Toast.makeText(this@MainActivity, "Erreur: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun updatePermissionStatus() {
        fun checkPerm(perm: String) = ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED

        val hasSms  = checkPerm(Manifest.permission.READ_SMS)
        val hasCall = checkPerm(Manifest.permission.READ_CALL_LOG)
        val hasNotif = isNotificationAccessEnabled()

        tvPermSms.text  = if (hasSms)  "✅  SMS" else "❌  SMS (requis)"
        tvPermCall.text = if (hasCall) "✅  Journal des appels" else "❌  Journal des appels (requis)"
        tvPermNotif.text = if (hasNotif) "✅  Accès aux notifications" else "❌  Accès aux notifications (requis)"

        tvPermSms.setTextColor(if (hasSms) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        tvPermCall.setTextColor(if (hasCall) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        tvPermNotif.setTextColor(if (hasNotif) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
    }

    private fun updateSyncStatus() {
        val running = SyncService.isRunning
        tvStatus.text = if (running) "🟢 Actif" else "⭕ Inactif"
        tvStatus.setTextColor(if (running) 0xFF22C55E.toInt() else 0xFF94A3B8.toInt())
        tvSyncInfo.text = if (running) "Service en cours d'exécution" else "Service arrêté"
        btnStart.isEnabled = !running
        btnStop.isEnabled = running
    }

    private fun isNotificationAccessEnabled(): Boolean {
        val cn = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return cn.contains(packageName)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST_CODE) {
            updatePermissionStatus()
            val granted = grantResults.count { it == PackageManager.PERMISSION_GRANTED }
            log("🔑 $granted/${permissions.size} permissions accordées")
        }
    }

    private fun log(message: String) {
        val time = DateFormat.format("HH:mm:ss", System.currentTimeMillis()).toString()
        logLines.addLast("[$time] $message")
        if (logLines.size > 20) logLines.removeFirst()
        tvLog.text = logLines.joinToString("\n")
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
