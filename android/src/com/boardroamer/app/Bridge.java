package com.boardroamer.app;

import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** What the page can ask the phone to do. Exposed to JavaScript as window.AndroidBridge. */
final class Bridge {
    private final MainActivity a;

    Bridge(MainActivity a) { this.a = a; }

    private static String msg(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    /** Asynchronous: the answer arrives through window.__nativeResult(id, json). */
    @JavascriptInterface
    public void save(int id, String url, String name, String dir, String metaJson, String ua) {
        new Thread(() -> {
            String out;
            try {
                out = Saver.save(a, url, name, dir, metaJson, ua).toString();
            } catch (Throwable e) {
                out = errorJson(msg(e));
            }
            a.resolve(id, out);
        }, "br-save").start();
    }

    /** True for addresses on this phone's own networks: home Wi-Fi, Tailscale, link-local names. Sync never leaves them. */
    static boolean privateHost(String h) {
        if (h == null) return false;
        h = h.toLowerCase(java.util.Locale.ROOT);
        if (h.equals("localhost") || h.endsWith(".local") || h.endsWith(".ts.net") || (!h.contains(".") && !h.contains(":"))) return true;
        String[] p = h.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]), b = Integer.parseInt(p[1]);
            return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) || (a == 100 && b >= 64 && b <= 127);
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** Library sync: one HTTP call to the desktop app on the local network. Answer: {status, rev, body}. */
    @JavascriptInterface
    public void http(int id, String method, String url, String headersJson, String body) {
        new Thread(() -> {
            String out;
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                if (!"http".equals(u.getProtocol()) || !privateHost(u.getHost())) throw new Exception("Only addresses on your own network are allowed");
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(40000);
                c.setRequestMethod(method);
                c.setUseCaches(false);
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject h = new JSONObject(headersJson);
                    java.util.Iterator<String> it = h.keys();
                    while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
                }
                if (body != null && !body.isEmpty()) {
                    byte[] b = body.getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(b.length);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream os = c.getOutputStream()) { os.write(b); }
                }
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) {
                    byte[] t = new byte[16384];
                    int n;
                    while ((n = in.read(t)) > 0) { buf.write(t, 0, n); if (buf.size() > 80 * 1024 * 1024) throw new Exception("Reply too large"); }
                    in.close();
                }
                String rev = c.getHeaderField("X-Rev");
                out = new JSONObject().put("status", code).put("rev", rev == null ? JSONObject.NULL : rev).put("body", new String(buf.toByteArray(), StandardCharsets.UTF_8)).toString();
            } catch (java.net.SocketTimeoutException e) {
                out = errorJson("The desktop did not answer. Is Board Roamer open there with sharing on?");
            } catch (java.net.ConnectException e) {
                out = errorJson("Could not reach the desktop. Check the address, that sharing is on, and that Windows Firewall allows Board Roamer.");
            } catch (Throwable e) {
                out = errorJson(msg(e));
            } finally {
                if (c != null) c.disconnect();
            }
            a.resolve(id, out);
        }, "br-sync").start();
    }

    /** Download the new APK from this project's GitHub release and hand it to Android's installer. */
    @JavascriptInterface
    public void installUpdate(int id, String url) {
        new Thread(() -> {
            String out;
            try {
                File f = new File(ShareProvider.dir(a), "update.apk");
                Updater.fetch(url, f, p -> a.runOnUiThread(() -> a.web.evaluateJavascript("window.__updProgress&&window.__updProgress(" + p + ")", null)));
                boolean allowed = Build.VERSION.SDK_INT < 26 || a.getPackageManager().canRequestPackageInstalls();
                if (!allowed) {
                    a.runOnUiThread(() -> a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
                    out = new JSONObject().put("status", "permission").toString();
                } else {
                    Uri u = Uri.parse("content://" + ShareProvider.AUTHORITY + "/update.apk");
                    Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    a.runOnUiThread(() -> a.startActivity(i));
                    out = new JSONObject().put("status", "installing").toString();
                }
            } catch (Throwable e) {
                out = errorJson(msg(e));
            }
            a.resolve(id, out);
        }, "br-update").start();
    }

    private static String errorJson(String m) {
        try { return new JSONObject().put("error", m).toString(); } catch (Exception e) { return "{\"error\":\"failed\"}"; }
    }

    @JavascriptInterface
    public String saveText(String name, String text, String type) {
        try {
            String uri = Saver.saveText(a, name, text, type);
            a.runOnUiThread(() -> Toast.makeText(a, "Saved to Downloads/Board Roamer/" + Saver.sanitize(name), Toast.LENGTH_SHORT).show());
            return uri;
        } catch (Throwable e) {
            a.runOnUiThread(() -> Toast.makeText(a, "Could not save: " + msg(e), Toast.LENGTH_LONG).show());
            return "";
        }
    }

    @JavascriptInterface
    public void openUrl(String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        a.runOnUiThread(() -> a.openExternal(url));
    }

    @JavascriptInterface
    public void reveal(String uri) {
        a.runOnUiThread(() -> {
            try {
                if (uri != null && uri.startsWith("content://")) {
                    Uri u = Uri.parse(uri);
                    Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, a.getContentResolver().getType(u)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    a.startActivity(i);
                    return;
                }
            } catch (Throwable ignored) { /* fall through to the Downloads list */ }
            try { a.startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Throwable ignored) { }
        });
    }

    @JavascriptInterface
    public void share(String text, String title) {
        a.runOnUiThread(() -> {
            Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
            if (title != null && !title.isEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, title);
            a.startActivity(Intent.createChooser(i, "Share"));
        });
    }

    @JavascriptInterface
    public void shareFile(String url, String name) {
        new Thread(() -> {
            try {
                File dir = ShareProvider.dir(a);
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 3600_000L) f.delete();
                String safe = Saver.sanitize(name);
                File out = new File(dir, safe);
                Net.download(url, null, out);
                Uri u = Uri.parse("content://" + ShareProvider.AUTHORITY + "/" + Uri.encode(safe));
                Intent i = new Intent(Intent.ACTION_SEND).setType(Saver.mime(Saver.ext(safe))).putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                a.runOnUiThread(() -> a.startActivity(Intent.createChooser(i, "Share image")));
            } catch (Throwable e) {
                a.runOnUiThread(() -> Toast.makeText(a, "Could not share: " + msg(e), Toast.LENGTH_LONG).show());
            }
        }, "br-share").start();
    }

    @JavascriptInterface
    public void copy(String text) {
        a.runOnUiThread(() -> {
            ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Board Roamer", text));
        });
    }

    @JavascriptInterface
    public void haptic(String kind) {
        a.runOnUiThread(() -> a.web.performHapticFeedback("heavy".equals(kind) ? HapticFeedbackConstants.LONG_PRESS : (Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.KEYBOARD_TAP)));
    }

    /** Is the app allowed to post notifications? (Always yes before Android 13.) */
    @JavascriptInterface
    public boolean notifyAllowed() {
        return Notifier.allowed(a);
    }

    /** Ask for the notification permission (Android 13+). The answer is read back with notifyAllowed(). */
    @JavascriptInterface
    public void requestNotify() {
        if (Build.VERSION.SDK_INT >= 33 && !notifyAllowed()) a.runOnUiThread(() -> a.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 7));
    }

    /** Local files: has the user allowed Android's "All files access"? */
    @JavascriptInterface
    public boolean localAccess() { return Local.access(); }

    /** Open Android's "All files access" screen for this app. */
    @JavascriptInterface
    public void requestLocalAccess() {
        a.runOnUiThread(() -> {
            try {
                a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + a.getPackageName())));
            } catch (Throwable e) {
                a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            }
        });
    }

    /** The desktop's address and the pairing code, so this phone can reach it (and tell it where this phone's folders are). */
    @JavascriptInterface
    public void setHub(String url, String code) { Local.setHub(url, code); }

    /** Other devices that share their folders: {hub, code, devices: {name: "http://ip:port"}}. */
    @JavascriptInterface
    public void setRemotes(String json) { Local.setRemotes(json); }

    /** Should links to the supported sites offer Board Roamer? (Turns the link alias on or off.) */
    @JavascriptInterface
    public void setLinks(boolean on) {
        try {
            a.getPackageManager().setComponentEnabledSetting(new android.content.ComponentName(a, "com.boardroamer.app.LinkAlias"),
                on ? android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED : android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                android.content.pm.PackageManager.DONT_KILL_APP);
        } catch (Throwable ignored) { }
    }

    /** Android's "Open by default" screen for this app, where "Open supported links" is switched on. */
    @JavascriptInterface
    public void openLinkSettings() {
        a.runOnUiThread(() -> {
            try {
                String act = Build.VERSION.SDK_INT >= 31 ? android.provider.Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS : android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS;
                a.startActivity(new Intent(act, Uri.parse("package:" + a.getPackageName())));
            } catch (Throwable e) {
                a.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.getPackageName())));
            }
        });
    }

    /** Post a notification (text only, see Notifier). */
    @JavascriptInterface
    public void notify(String title, String body) { Notifier.post(a, title, body); }

    /** The page's list of things to look for while the app is closed (see Watch). */
    @JavascriptInterface
    public void setWatch(String json) { Watch.update(a, json); }

    @JavascriptInterface public void setImmersive(boolean on) { a.runOnUiThread(() -> a.applyImmersive(on)); }
    @JavascriptInterface public void setOrientation(String mode) { a.runOnUiThread(() -> a.setOrientationMode(mode)); }
    @JavascriptInterface public void setBars(String colorHex, boolean lightIcons) { a.runOnUiThread(() -> a.setBars(colorHex, lightIcons)); }
    @JavascriptInterface public void keepAwake(boolean on) { a.runOnUiThread(() -> a.keepAwake(on)); }
    @JavascriptInterface public void setSecure(boolean on) { a.runOnUiThread(() -> a.setSecure(on)); }
    @JavascriptInterface public void exitApp() { a.runOnUiThread(a::moveTaskToBack0); }

    @JavascriptInterface
    public String info() {
        try {
            return new JSONObject().put("app", "Board Roamer").put("version", a.versionName()).put("sdk", Build.VERSION.SDK_INT).put("device", Build.MANUFACTURER + " " + Build.MODEL).toString();
        } catch (Exception e) {
            return "{}";
        }
    }
}
