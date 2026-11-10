
package com.dapp.shell;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.view.WindowManager;
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

            String sourceType = config.optString("sourceType", "url");
            String url = config.optString("url", "");

            if (config.optBoolean("tetapMenyala", false)) {
                getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                );
            }

            webView = new WebView(this);
            webView.setWebViewClient(new WebViewClient());

            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setLoadWithOverviewMode(true);
            settings.setUseWideViewPort(true);

            setContentView(webView);

            if ("html".equalsIgnoreCase(sourceType)) {
                webView.loadUrl("file:///android_asset/index.html");
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
                "Gagal membuka aplikasi: " + e.getMessage(),
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
