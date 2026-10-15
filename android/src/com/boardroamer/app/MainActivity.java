package com.boardroamer.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Board Roamer on Android: a WebView that serves the same web app the desktop version embeds. The page is loaded
 * from https://appassets.androidplatform.net/ (served out of the APK), and requests to /proxy, /img, /ping and /open
 * are answered here instead of by the desktop app's local server.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String BASE = "https://" + HOST + "/index.html";
    private static final String TAG = "BoardRoamer";
    private static final int REQ_FILE = 71;

    WebView web;
    private ValueCallback<Uri[]> chooser;
    private String pendingHash = "";
    private boolean immersive;
    private int barColor = 0xFF0A1113;
    private boolean lightIcons = true;

    /* ------------------------------------------------------------------ lifecycle */
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        Window w = getWindow();
        w.setBackgroundDrawable(new ColorDrawable(0xFF0A1113));
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setBars("#0a1113", true);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0A1113);
        setContentView(web);
        configure();
        handleIntent(getIntent());
        web.loadUrl(BASE + pendingHash);
        pendingHash = "";
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleIntent(i);
        if (!pendingHash.isEmpty()) {
            web.evaluateJavascript("location.hash=" + JSONObject.quote(pendingHash.substring(1)), null);
            pendingHash = "";
        }
    }

    @Override protected void onPause() { web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }

    @Override protected void onDestroy() {
        if (web != null) { web.removeAllViews(); web.destroy(); }
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("String(!!(window.__back && window.__back()))", v -> {
            if (v == null || !v.contains("true")) moveTaskToBack(true);
        });
    }

    void moveTaskToBack0() { moveTaskToBack(true); }

    String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /* ------------------------------------------------------------------ WebView */
    private void configure() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " BoardRoamerAndroid/" + versionName());
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true); // no native callout menus: the page does its own long-press
        web.setHapticFeedbackEnabled(true);
        web.addJavascriptInterface(new Bridge(this), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                try {
                    return intercept(r);
                } catch (Throwable t) {
                    Log.w(TAG, "intercept failed", t);
                    return text(500, "text/plain", "internal error");
                }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                String sc = u.getScheme();
                if ("http".equals(sc) || "https".equals(sc)) openExternal(u.toString());
                return true; // never navigate the app away from itself
            }

            @Override public void onPageStarted(WebView v, String url, Bitmap f) { v.setBackgroundColor(0xFF0A1113); }

            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                Log.w(TAG, "render process gone (crashed=" + d.didCrash() + "), reloading");
                recreate();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.sourceId() + ":" + m.lineNumber() + " " + m.message());
                return true;
            }

            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = cb;
                try {
                    startActivityForResult(p.createIntent(), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    chooser = null;
                    return false;
                }
                return true;
            }
        });
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && chooser != null) {
            chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            chooser = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    /* ------------------------------------------------------------------ request interception: assets + the local "server" */
    private static String header(Map<String, String> h, String name) {
        if (h == null) return null;
        for (Map.Entry<String, String> e : h.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        return null;
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 410: return "Gone";
            case 421: return "Misdirected";
            case 422: return "Unprocessable";
            case 429: return "Too Many Requests";
            default: return code >= 500 ? "Server Error" : "Status";
        }
    }

    private static WebResourceResponse build(int code, String contentType, InputStream body, Map<String, String> extra) {
        String mime = "application/octet-stream", charset = null;
        if (contentType != null) {
            String[] parts = contentType.split(";");
            mime = parts[0].trim().toLowerCase(Locale.ROOT);
            for (String p : parts) {
                p = p.trim();
                if (p.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = p.substring(8).replace("\"", "");
            }
        }
        if (code >= 300 && code < 400) code = 502;
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        if (extra != null) h.putAll(extra);
        return new WebResourceResponse(mime, charset, code, reason(code), h, body);
    }

    private static WebResourceResponse text(int code, String mime, String s) {
        return build(code, mime + "; charset=utf-8", new ByteArrayInputStream(s.getBytes(java.nio.charset.StandardCharsets.UTF_8)), null);
    }

    private WebResourceResponse intercept(WebResourceRequest r) {
        Uri u = r.getUrl();
        if (!HOST.equals(u.getHost())) return null; // CDN images/video etc. load directly
        String path = u.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        switch (path) {
            case "/proxy": return proxy(r, u);
            case "/img": return image(u);
            case "/ping": return text(200, "text/plain", "board-roamer");
            case "/open":
                runOnUiThread(() -> {
                    String link = u.getQueryParameter("u");
                    if (link != null && (link.startsWith("https://") || link.startsWith("http://"))) openExternal(link);
                });
                return text(200, "application/json", "{}");
            case "/save": return text(501, "application/json", "{\"error\":\"saving goes through the Android bridge\"}");
            default: return asset(path);
        }
    }

    private WebResourceResponse proxy(WebResourceRequest r, Uri u) {
        String target = u.getQueryParameter("u");
        if (target == null) return text(400, "application/json", "{\"error\":\"missing u\"}");
        Map<String, String> h = r.getRequestHeaders();
        Net.Resp resp = Net.api(r.getMethod(), target, header(h, "x-br-ua"), header(h, "x-br-auth"), null);
        Map<String, String> extra = new HashMap<>();
        extra.put("Cache-Control", "no-store");
        return build(resp.code, resp.contentType, new ByteArrayInputStream(resp.body), extra);
    }

    private WebResourceResponse image(Uri u) {
        String target = u.getQueryParameter("u");
        if (target == null) return text(400, "application/json", "{\"error\":\"missing u\"}");
        try {
            final HttpURLConnection c = Net.openImage(target);
            int code = c.getResponseCode();
            if (code >= 400) { c.disconnect(); return text(code, "application/json", "{\"error\":\"upstream refused\"}"); }
            InputStream in = new FilterInputStream(c.getInputStream()) {
                @Override public void close() throws IOException { try { super.close(); } finally { c.disconnect(); } }
            };
            Map<String, String> extra = new HashMap<>();
            extra.put("Cache-Control", "public, max-age=86400");
            return build(200, c.getContentType(), in, extra);
        } catch (IOException e) {
            return text(502, "application/json", "{\"error\":\"upstream failed\"}");
        }
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private WebResourceResponse asset(String path) {
        try {
            String clean = path.replace("..", "");
            InputStream in = getAssets().open("ui" + clean);
            Map<String, String> extra = new HashMap<>();
            extra.put("Cache-Control", "no-cache");
            return build(200, mimeOf(clean), in, extra);
        } catch (FileNotFoundException e) {
            return text(404, "text/plain", "not found");
        } catch (IOException e) {
            return text(500, "text/plain", "asset error");
        }
    }

    /* ------------------------------------------------------------------ links in from other apps */
    private static final Pattern[] POST_LINKS = {
            Pattern.compile("(e621|e926)\\.net/posts/(\\d+)"),
            Pattern.compile("danbooru\\.donmai\\.us/posts/(\\d+)"),
            Pattern.compile("(gelbooru\\.com|safebooru\\.org)/index\\.php\\?[^\\s]*[?&]id=(\\d+)"),
    };

    static String hashFor(String s) {
        if (s == null) return "";
        Matcher m;
        if ((m = POST_LINKS[0].matcher(s)).find()) return "#/roam?p=" + m.group(1) + "&post=" + m.group(2);
        if ((m = POST_LINKS[1].matcher(s)).find()) return "#/roam?p=danbooru&post=" + m.group(1);
        if ((m = POST_LINKS[2].matcher(s)).find()) return "#/roam?p=" + (m.group(1).startsWith("gel") ? "gelbooru" : "safebooru") + "&post=" + m.group(2);
        return "";
    }

    private void handleIntent(Intent i) {
        if (i == null) return;
        String s = null;
        if (Intent.ACTION_VIEW.equals(i.getAction()) && i.getData() != null) s = i.getDataString();
        else if (Intent.ACTION_SEND.equals(i.getAction())) s = i.getStringExtra(Intent.EXTRA_TEXT);
        pendingHash = hashFor(s);
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) { /* no browser: nothing to do */ }
    }

    /* ------------------------------------------------------------------ results back to the page */
    void resolve(int id, String json) {
        runOnUiThread(() -> web.evaluateJavascript("window.__nativeResult(" + id + "," + JSONObject.quote(json) + ")", null));
    }

    /* ------------------------------------------------------------------ system UI */
    void setBars(String hex, boolean light) {
        try { barColor = Color.parseColor(hex); } catch (Exception ignored) { }
        lightIcons = light;
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(barColor);
        w.setNavigationBarColor(barColor);
        if (Build.VERSION.SDK_INT >= 30) {
            w.getDecorView(); // installs the decor; getInsetsController() is null-unsafe before it exists
            WindowInsetsController c = null;
            try { c = w.getInsetsController(); } catch (RuntimeException ignored) { }
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light ? 0 : mask, mask);
            }
        } else {
            int f = w.getDecorView().getSystemUiVisibility();
            int bits = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            w.getDecorView().setSystemUiVisibility(light ? (f & ~bits) : (f | bits));
        }
    }

    @SuppressWarnings("deprecation")
    void applyImmersive(boolean on) {
        immersive = on;
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.getDecorView();
            WindowInsetsController c = null;
            try { c = w.getInsetsController(); } catch (RuntimeException ignored) { }
            if (c == null) return;
            if (on) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else c.show(WindowInsets.Type.systemBars());
        } else {
            int base = w.getDecorView().getSystemUiVisibility();
            int flags = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION;
            w.getDecorView().setSystemUiVisibility(on ? (base | flags) : (base & ~flags));
        }
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) applyImmersive(true); // the bars come back after a dialog or the share sheet
    }

    void setOrientationMode(String mode) {
        setRequestedOrientation("landscape".equals(mode) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    void keepAwake(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    void setSecure(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
}
