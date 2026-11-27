package com.clubgames.khlgm;

import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The game in a full-screen landscape WebView: system bars hidden (a swipe from the edge shows them for a moment),
 * the screen stays on while the app is in front (live matches, 3D replays, video export).
 *
 * Mods installed from a .zip are written by the page into files/mods/<id>/… and served from there for
 * https://localhost/mods/<id>/… (the browser version uses a service worker for that). A service worker left
 * registered in the WebView could keep the page from loading at all once the app had been closed or updated — a plain
 * coloured screen — so every registration is deleted before the WebView starts. If the page still has not come up
 * after a while, the WebView cache is dropped and the page loaded again (once).
 */
public class MainActivity extends BridgeActivity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private static long lastRestart = 0;
    private boolean retried = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // before the WebView exists: no service worker may stand between it and the game's page
        dropServiceWorkers();
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView web = getBridge().getWebView();
            WebSettings settings = web.getSettings();
            // Saves live in the WebView storage; the game never needs zoom gestures or text autosizing.
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setTextZoom(100);
            settings.setSupportZoom(false);
            settings.setMediaPlaybackRequiresUserGesture(false);
            // stored mods from the app's files, everything else as Capacitor serves it
            BridgeWebViewClient client = new BridgeWebViewClient(getBridge()) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    WebResourceResponse mod = storedModFile(request);
                    return mod != null ? mod : super.shouldInterceptRequest(view, request);
                }
            };
            getBridge().setWebViewClient(client);
            web.setWebViewClient(client);
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    // the page's renderer died: start over (not in a loop)
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastRestart > 20000) {
                        lastRestart = now;
                        ui.post(MainActivity.this::recreate);
                    }
                    return true;
                }
            });
            ui.postDelayed(this::checkStarted, 15000);
        }
        hideSystemBars();
    }

    /** Deletes the WebView's service worker registrations (both the old and the profile-based data layout). */
    private void dropServiceWorkers() {
        try {
            File base = new File(getApplicationInfo().dataDir, "app_webview");
            deleteTree(new File(base, "Service Worker"));
            deleteTree(new File(new File(base, "Default"), "Service Worker"));
        } catch (Exception ignored) {
            // nothing there, or not ours to delete
        }
    }

    private static void deleteTree(File f) {
        if (!f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** The interface has not appeared: drop the WebView cache and load the page again (once per launch). */
    private void checkStarted() {
        if (retried || isFinishing() || getBridge() == null || getBridge().getWebView() == null) return;
        final WebView web = getBridge().getWebView();
        web.evaluateJavascript("(function(){return !!(window.__khlMounted||document.getElementById('khl-boot-diag'))})()", value -> {
            if ("true".equals(value) || retried) return;
            retried = true;
            web.clearCache(true);
            web.reload();
        });
    }

    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        TYPES.put("json", "application/json");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("jpeg", "image/jpeg");
        TYPES.put("webp", "image/webp");
        TYPES.put("gif", "image/gif");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("avif", "image/avif");
        TYPES.put("txt", "text/plain");
        TYPES.put("md", "text/plain");
    }

    /** https://localhost/mods/<id>/<file> of a mod installed from a .zip (files/mods/…); null: not one of those. */
    private WebResourceResponse storedModFile(WebResourceRequest request) {
        try {
            if (!"GET".equalsIgnoreCase(request.getMethod())) return null;
            Uri url = request.getUrl();
            String path = url.getPath();
            if (path == null || !path.startsWith("/mods/") || !"localhost".equals(url.getHost())) return null;
            String rel = path.substring("/mods/".length());
            if (!rel.contains("/")) return null;
            File root = new File(getFilesDir(), "mods");
            File f = new File(root, rel);
            if (!f.isFile() || !f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) return null;
            String name = f.getName(), ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
            String type = TYPES.containsKey(ext) ? TYPES.get(ext) : "application/octet-stream";
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(type, type.startsWith("text/") || type.equals("application/json") ? "utf-8" : null, 200, "OK", headers, new FileInputStream(f));
        } catch (IOException | RuntimeException e) {
            return null;
        }
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
