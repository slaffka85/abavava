package ru.abavava.chat;

import android.webkit.WebView;
import com.google.firebase.messaging.FirebaseMessaging;

public final class PushTokenBridge {
    private PushTokenBridge() {}
    public static void emitToken(WebView webView) {
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            String safe = token.replace("\\", "\\\\").replace("'", "\\'");
            webView.post(() -> webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('abv-fcm-token',{detail:'" + safe + "'}))", null));
        });
    }
}
