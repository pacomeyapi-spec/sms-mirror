package com.yapsonpress.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val PREFS = "yapsonpress"
    private var currentUrl: String = ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.setBackgroundColor(Color.WHITE)
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_DEFAULT

        webView.addJavascriptInterface(JsBridge(this), "AndroidBridge")

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                // Erreur sur la page principale → proposer de re-saisir l'adresse
                if (request != null && request.isForMainFrame) {
                    runOnUiThread { askServerUrl(true) }
                }
            }
        }

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val url = prefs.getString("server_url", null)
        if (url.isNullOrBlank()) askServerUrl(false) else loadApp(url)
    }

    private fun askServerUrl(isError: Boolean) {
        val input = EditText(this).apply {
            hint = "https://votre-yapsonpress.up.railway.app"
            val prev = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("server_url", "https://")
            setText(prev)
            setSelection(text.length)
        }
        val pad = (16 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Adresse de YapsonPress")
            .setMessage(if (isError) "Impossible de charger la page. Vérifie l'adresse du serveur." else "Entre l'adresse de ton serveur YapsonPress.")
            .setView(box)
            .setCancelable(false)
            .setPositiveButton("Valider") { _, _ ->
                var u = input.text.toString().trim().trimEnd('/')
                if (u.isNotBlank() && !u.startsWith("http")) u = "https://$u"
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("server_url", u).apply()
                loadApp(u)
            }
            .show()
    }

    private fun loadApp(baseUrl: String) {
        currentUrl = baseUrl.trimEnd('/')
        webView.loadUrl("$currentUrl/m")
    }

    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /** Pont JS → Android pour copier le token dans le presse-papiers de façon fiable. */
    inner class JsBridge(private val ctx: Context) {
        @JavascriptInterface
        fun copy(text: String) {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("token", text))
        }
    }
}
