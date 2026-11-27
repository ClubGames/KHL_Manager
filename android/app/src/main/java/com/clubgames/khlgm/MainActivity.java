package com.clubgames.khlgm;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * The game in a full-screen WebView: system bars hidden (a swipe from the edge shows them for a moment),
 * the screen stays on while the app is in front (live matches, 3D replays, video export).
 *
 * The game is landscape, but the activity starts in whatever orientation the phone is held: a WebView rotated while it
 * is still being created (the phone held upright at launch) could stay black. So landscape is asked for only once the
 * page has loaded, every rotation re-lays the WebView out and tells the page, and a lost renderer restarts the app.
 */
public class MainActivity extends BridgeActivity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean landscape = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            // Saves live in the WebView storage; the game never needs zoom gestures or text autosizing.
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setTextZoom(100);
            settings.setSupportZoom(false);
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
        hideSystemBars();
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    ui.postDelayed(MainActivity.this::goLandscape, 300);
                }

                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    ui.post(MainActivity.this::recreate);
                    return true;
                }
            });
        }
        // in case the page never reports in (it still has to be landscape)
        ui.postDelayed(this::goLandscape, 6000);
    }

    private void goLandscape() {
        if (landscape || isFinishing()) return;
        landscape = true;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        hideSystemBars();
        relayout();
        // once more after the rotation animation (some phones report the new size late)
        ui.postDelayed(this::relayout, 450);
    }

    /** The WebView laid out and redrawn at the new size, and the page told (canvases, the match layout). */
    private void relayout() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView web = getBridge().getWebView();
        web.requestLayout();
        web.invalidate();
        View root = getWindow().getDecorView();
        root.requestLayout();
        web.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null);
    }

    @Override
    public void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
