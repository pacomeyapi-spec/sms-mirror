package com.yapson.notifclean

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {

    private lateinit var statutAcces: TextView
    private lateinit var statutInfo: TextView
    private lateinit var btnAcces: Button
    private lateinit var swActif: Switch
    private lateinit var spInterval: Spinner
    private lateinit var spDelai: Spinner

    private val intervals = listOf(30, 60, 120, 300)
    private val delais    = listOf(0, 30, 60, 120)

    private val ui = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() { majEtat(); ui.postDelayed(this, 3000) }
    }

    private fun prefs() = getSharedPreferences(WaveCleanerService.PREFS, Context.MODE_PRIVATE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(28))
        }

        col.addView(TextView(this).apply {
            text = "🧹 Wave Clean"
            textSize = 24f
            setTextColor(Color.parseColor("#0F172A"))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        col.addView(TextView(this).apply {
            text = "Efface automatiquement les notifications Wave (perso et business) restées affichées."
            textSize = 13f
            setTextColor(Color.parseColor("#64748B"))
            setPadding(0, dp(6), 0, dp(18))
        })

        // Bloc état
        statutAcces = TextView(this).apply {
            textSize = 15f
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setBackgroundColor(Color.parseColor("#F1F5F9"))
        }
        col.addView(statutAcces)

        btnAcces = Button(this).apply {
            text = "Autoriser l'accès aux notifications"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        }
        col.addView(btnAcces, lp(dp(10)))

        // Activation
        swActif = Switch(this).apply {
            text = "  Nettoyage automatique"
            textSize = 16f
            isChecked = prefs().getBoolean(WaveCleanerService.K_ENABLED, true)
            setOnCheckedChangeListener { _, v ->
                prefs().edit().putBoolean(WaveCleanerService.K_ENABLED, v).apply()
                notifierService(WaveCleanerService.ACTION_CONFIG)
                majEtat()
            }
        }
        col.addView(swActif, lp(dp(18)))

        // Fréquence
        col.addView(label("Fréquence du nettoyage"), lp(dp(14)))
        spInterval = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                listOf("Toutes les 30 secondes", "Toutes les minutes", "Toutes les 2 minutes", "Toutes les 5 minutes"))
            setSelection(intervals.indexOf(prefs().getInt(WaveCleanerService.K_INTERVAL, WaveCleanerService.DEF_INTERVAL)).coerceAtLeast(0))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                    prefs().edit().putInt(WaveCleanerService.K_INTERVAL, intervals[pos]).apply()
                    notifierService(WaveCleanerService.ACTION_CONFIG)
                }
                override fun onNothingSelected(p: AdapterView<*>?) {}
            }
        }
        col.addView(spInterval)

        // Délai de sécurité
        col.addView(label("Délai de sécurité avant effacement"), lp(dp(14)))
        col.addView(TextView(this).apply {
            text = "La notification n'est effacée qu'après ce délai, pour laisser à SMS Mirror le temps de la capturer et de l'envoyer."
            textSize = 12f
            setTextColor(Color.parseColor("#64748B"))
            setPadding(0, dp(2), 0, dp(6))
        })
        spDelai = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                listOf("Aucun (immédiat)", "30 secondes", "1 minute (recommandé)", "2 minutes"))
            setSelection(delais.indexOf(prefs().getInt(WaveCleanerService.K_MIN_AGE, WaveCleanerService.DEF_MIN_AGE)).coerceAtLeast(0))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                    prefs().edit().putInt(WaveCleanerService.K_MIN_AGE, delais[pos]).apply()
                    notifierService(WaveCleanerService.ACTION_CONFIG)
                }
                override fun onNothingSelected(p: AdapterView<*>?) {}
            }
        }
        col.addView(spDelai)

        // Nettoyer maintenant
        col.addView(Button(this).apply {
            text = "🧹 Nettoyer maintenant"
            setOnClickListener {
                notifierService(WaveCleanerService.ACTION_SWEEP)
                ui.postDelayed({ majEtat() }, 700)
                Toast.makeText(this@MainActivity, "Nettoyage lancé", Toast.LENGTH_SHORT).show()
            }
        }, lp(dp(18)))

        // Batterie
        col.addView(Button(this).apply {
            text = "🔋 Ignorer l'optimisation batterie"
            setOnClickListener {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    })
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Non disponible sur cet appareil", Toast.LENGTH_SHORT).show()
                }
            }
        }, lp(dp(10)))

        // Statistiques
        statutInfo = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.parseColor("#334155"))
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setBackgroundColor(Color.parseColor("#F8FAFC"))
        }
        col.addView(statutInfo, lp(dp(20)))

        root.addView(col)
        setContentView(root)
        majEtat()
    }

    override fun onResume() { super.onResume(); ui.post(refresh) }
    override fun onPause()  { super.onPause();  ui.removeCallbacks(refresh) }

    private fun notifierService(action: String) = sendBroadcast(Intent(action).setPackage(packageName))

    private fun accesAccorde(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        if (TextUtils.isEmpty(flat)) return false
        return flat.split(":").any { it.contains(packageName) }
    }

    private fun majEtat() {
        val ok = accesAccorde()
        statutAcces.text = if (ok) "✅ Accès aux notifications accordé" else "⚠️ Accès aux notifications NON accordé\nAppuie sur le bouton ci-dessous, puis active « Wave Clean »."
        statutAcces.setTextColor(Color.parseColor(if (ok) "#166534" else "#B91C1C"))
        statutAcces.setBackgroundColor(Color.parseColor(if (ok) "#ECFDF5" else "#FEF2F2"))
        btnAcces.visibility = if (ok) android.view.View.GONE else android.view.View.VISIBLE

        val p = prefs()
        val last = p.getLong(WaveCleanerService.K_LAST_RUN, 0L)
        val fmt = SimpleDateFormat("HH:mm:ss", Locale.FRANCE)
        val quand = if (last > 0) fmt.format(Date(last)) else "—"
        val actif = p.getBoolean(WaveCleanerService.K_ENABLED, true)
        statutInfo.text = buildString {
            append("État : ").append(if (actif) "nettoyage actif" else "en pause").append("\n")
            append("Dernier passage : ").append(quand).append("\n")
            append("Notifications Wave présentes : ").append(p.getInt(WaveCleanerService.K_SEEN, 0)).append("\n")
            append("Effacées au dernier passage : ").append(p.getInt(WaveCleanerService.K_LAST_CNT, 0)).append("\n")
            append("Total effacées : ").append(p.getInt(WaveCleanerService.K_TOTAL, 0))
        }
    }

    private fun label(t: String) = TextView(this).apply {
        text = t; textSize = 14f
        setTextColor(Color.parseColor("#0F172A"))
        setTypeface(typeface, android.graphics.Typeface.BOLD)
    }
    private fun lp(topMargin: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { setMargins(0, topMargin, 0, 0) }
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
