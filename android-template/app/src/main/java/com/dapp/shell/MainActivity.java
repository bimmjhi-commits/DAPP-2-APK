package com.myapp.app;
import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
public class MainActivity extends Activity {
  @Override protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    TextView tv = new TextView(this);
    tv.setText("HALO, KALO INI MUNCUL BERARTI APK-nya NORMAL");
    tv.setTextSize(24);
    setContentView(tv);
  }
}
