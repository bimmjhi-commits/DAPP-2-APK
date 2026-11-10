package com.myapp.app;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
public class MainActivity extends Activity {
  private WebView webView;
  @Override protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    try {
      webView = new WebView(this);
      setContentView(webView);
      WebSettings s = webView.getSettings();
      s.setJavaScriptEnabled(true);
      s.setDomStorageEnabled(true);
      s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
      webView.setWebViewClient(new WebViewClient());
      webView.loadUrl("https://google.com");
    } catch (Exception e) {
      android.widget.TextView tv = new android.widget.TextView(this);
      tv.setText("WebView Error: " + e.getMessage());
      setContentView(tv);
    }
  }
  @Override public void onBackPressed() {
    if (webView != null && webView.canGoBack()) webView.goBack();
    else super.onBackPressed();
  }
}
