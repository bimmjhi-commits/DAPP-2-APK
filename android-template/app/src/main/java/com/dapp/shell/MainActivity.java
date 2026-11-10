
package com.dapp.shell;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            InputStream input = getAssets().open("config.json");
            byte[] data = new byte[input.available()];
            input.read(data);
            input.close();

            JSONObject config = new JSONObject(
                new String(data, StandardCharsets.UTF_8)
            );

            if (config.optBoolean("keepScreenOn", false)) {
                getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                );
            }

            if (config.optBoolean("fullscreen", false)) {
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                );
            }

            String sourceType =
                config.optString("sourceType", "url");

            String url = config.optString("url", "");

            webView = new WebView(this);
            webView.setWebViewClient(new WebViewClient());

            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setLoadWithOverviewMode(true);
            settings.setUseWideViewPort(true);

            setContentView(webView);

            if ("html".equalsIgnoreCase(sourceType)) {
                webView.loadUrl(
                    "file:///android_asset/index.html"
                );
            } else if (!url.isEmpty()) {
                webView.loadUrl(url);
            } else {
                Toast.makeText(this,
                    "Alamat website belum tersedia",
                    Toast.LENGTH_LONG
                ).show();
            }

        } catch (Exception e) {
            Toast.makeText(this,
                "Gagal membuka aplikasi",
                Toast.LENGTH_LONG
            ).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
