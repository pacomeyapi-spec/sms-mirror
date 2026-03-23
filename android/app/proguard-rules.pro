# ProGuard rules for SMS Mirror

# OkHttp
-dontwarn okhttp3.**
-keep class okhttp3.** { *; }

# Gson
-keep class com.google.gson.** { *; }

# Notre app
-keep class com.smsmirror.app.** { *; }
