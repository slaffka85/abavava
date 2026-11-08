package ru.abavava.chat;

import android.Manifest;
import android.os.Build;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String SERVER_URL_KEY = "server_url";
    private static final int MEDIA_PERMISSION_REQUEST = 4102;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4103;
    private static volatile boolean visible;
    public static boolean isVisible() { return visible; }

    private WebView webView;
    private PermissionRequest pendingWebPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(13, 16, 22));
        getWindow().setNavigationBarColor(Color.rgb(13, 16, 22));

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                PushTokenBridge.emitToken(view);
            }
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request.isForMainFrame() && errorResponse.getStatusCode() == 404) {
                    runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                            .setTitle("Не найден веб-клиент")
                            .setMessage("По этому адресу отвечает API-сервер. Укажите адрес веб-клиента, например порт 8081 или 5174.")
                            .setPositiveButton("Изменить адрес", (dialog, which) -> askForServerUrl())
                            .setNegativeButton("Повторить", (dialog, which) -> view.reload())
                            .show());
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingWebPermission == request) pendingWebPermission = null;
            }
        });
        setContentView(webView);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }

        String savedUrl = getPreferences(MODE_PRIVATE).getString(SERVER_URL_KEY, null);
        //if (savedUrl == null || savedUrl.trim().isEmpty())
            askForServerUrl();
        //else webView.loadUrl(savedUrl);
    }

    @Override protected void onResume() { super.onResume(); visible = true; }
    @Override protected void onPause() { visible = false; super.onPause(); }

    private void handleWebPermission(PermissionRequest request) {
        List<String> allowed = new ArrayList<>();
        boolean needsCamera = false;
        boolean needsMic = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                allowed.add(resource);
                needsCamera = true;
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                allowed.add(resource);
                needsMic = true;
            }
        }
        if (allowed.isEmpty()) {
            request.deny();
            return;
        }

        List<String> missing = new ArrayList<>();
        if (needsCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            missing.add(Manifest.permission.CAMERA);
        if (needsMic && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            missing.add(Manifest.permission.RECORD_AUDIO);

        if (missing.isEmpty()) {
            request.grant(allowed.toArray(new String[0]));
        } else {
            pendingWebPermission = request;
            requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
        }
    }

    private void askForServerUrl() {
        EditText input = new EditText(this);
        input.setHint("https://192.168.1.222:5174");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        String saved = getPreferences(MODE_PRIVATE).getString(SERVER_URL_KEY, "");
        input.setText(saved);

        new AlertDialog.Builder(this)
                .setTitle("Адрес сервера")
                .setMessage("Введите адрес запущенного Chat Abavava. Телефон и сервер должны быть в одной сети.")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("Подключиться", (dialog, which) -> {
                    String value = input.getText().toString().trim().replaceAll("/+$", "");
                    if (!value.startsWith("https://") && !value.startsWith("http://") && !value.isEmpty())
                        value = "http://" + value;
                    if (value.isEmpty()) {
                        Toast.makeText(this, "Введите адрес сервера", Toast.LENGTH_LONG).show();
                        askForServerUrl();
                    } else {
                        getPreferences(MODE_PRIVATE).edit().putString(SERVER_URL_KEY, value).apply();
                        webView.loadUrl(value);
                    }
                })
                .setNegativeButton("Закрыть", (dialog, which) -> finish())
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) return;
        if (requestCode != MEDIA_PERMISSION_REQUEST || pendingWebPermission == null) return;
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) granted &= result == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            List<String> allowed = new ArrayList<>();
            for (String resource : pendingWebPermission.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                        || PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) allowed.add(resource);
            }
            if (allowed.isEmpty()) pendingWebPermission.deny();
            else pendingWebPermission.grant(allowed.toArray(new String[0]));
        } else pendingWebPermission.deny();
        pendingWebPermission = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
