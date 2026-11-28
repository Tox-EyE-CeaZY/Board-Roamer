package com.boardroamer.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Fur Affinity on Android: the /fa/* API the page uses (same as src/fa.rs on desktop), the saved session, and a WebView
 * window where the person signs in, passes Cloudflare's check, has their watch list read, or watches / unwatches an artist.
 * Passwords and the check stay between the person and the site: only the cookies the site sets are read, then the window closes.
 * The session lives in app-private storage and is never handed to the page, only whether it exists.
 */
final class Fa {
    private Fa() {}

    private static final String WWW = "https://www.furaffinity.net/";
    private static final String PROBE = "JSON.stringify({w:(()=>{const a=[...document.querySelectorAll('#site-content a[href]')].map(a=>a.href);const u=a.find(h=>/\\/unwatch\\//.test(h));const wt=a.find(h=>/\\/watch\\//.test(h)&&!/unwatch/.test(h));return u?{s:1,l:u}:wt?{s:0,l:wt}:{s:-1,l:''}})(),ua:navigator.userAgent,title:document.title,path:location.pathname,host:location.hostname,next:(()=>{if(!/^\\/controls\\/buddylist/.test(location.pathname))return '';const ok=a=>{const u=new URL(a.href,location.href);return u.hostname==='www.furaffinity.net'&&/^\\/(controls\\/buddylist|watchlist)/.test(u.pathname)&&!/remove|add/.test(u.search)&&u.href!==location.href};const as=[...document.querySelectorAll('#site-content a[href]')].filter(a=>{try{return ok(a)}catch(e){return false}});const a=as.find(a=>a.rel==='next'||/^\\s*(next|older|>|>>|›|»)|next/i.test(a.textContent)&&!/prev|back/i.test(a.textContent))||as.find(a=>/[?&]page=/.test(a.href)&&!/prev/i.test(a.textContent)&&Number((/[?&]page=(\\d+)/.exec(a.href)||[])[1])>Number((/[?&]page=(\\d+)/.exec(location.search)||[,1])[1]));return a?a.href:''})(),names:/^\\/controls\\/buddylist/.test(location.pathname)?[...new Set([...document.querySelectorAll('#site-content a[href*=\"/user/\"]')].map(a=>{const m=/\\/user\\/([^/?#]+)/.exec(a.getAttribute('href')||'');if(!m)return '';let n=m[1];try{n=decodeURIComponent(n)}catch(e){}const f=s=>String(s||'').toLowerCase().replace(/[\\s_~@.\\-]+/g,'');return f(a.textContent)===f(n)?n:''}).filter(Boolean))]:[]})";
    static final int LOGIN = 0, VERIFY = 1, WATCH = 2, ACT = 3;

    private static Activity act;
    private static SharedPreferences prefs;
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static volatile JSONArray watchNames = null;
    private static volatile JSONObject actResult = null;
    private static Win win;

    static void init(Activity activity) {
        act = activity;
        prefs = activity.getSharedPreferences("fa", Context.MODE_PRIVATE);
        FaNet.load(prefs.getString("a", ""), prefs.getString("b", ""), prefs.getString("clearance", ""), prefs.getString("ua", ""));
    }

    private static void persist() {
        String[] s = FaNet.snapshot();
        if (prefs != null) prefs.edit().putString("a", s[0]).putString("b", s[1]).putString("clearance", s[2]).putString("ua", s[3]).apply();
    }

    /* ------------------------------------------------------------------ /fa/* */
    private static Net.Resp json(int code, String s) { return new Net.Resp(code, "application/json", s.getBytes(StandardCharsets.UTF_8)); }

    private static String status() {
        return "{\"connected\":" + FaNet.connected() + ",\"cleared\":" + FaNet.cleared() + ",\"ua\":" + FaNet.hasUa() + ",\"gen\":" + FaNet.generation() + "}";
    }

    /** `q` is the page's JSON arguments (the webview gives a handler no request body, so they travel in the address). */
    static Net.Resp handle(String path, String method, String q) {
        boolean post = "POST".equals(method);
        JSONObject args;
        try { args = q == null || q.isEmpty() ? new JSONObject() : new JSONObject(q); } catch (Exception e) { args = new JSONObject(); }
        switch (path) {
            case "/fa/status": return json(200, status());
            case "/fa/login": if (post) open(LOGIN, null, false); return json(200, "{\"ok\":true}");
            case "/fa/verify": if (post) open(VERIFY, null, false); return json(200, "{\"ok\":true}");
            case "/fa/paste": {
                String a = args.optString("a", "").trim(), b = args.optString("b", "").trim();
                if (!(FaNet.sane(a) && FaNet.sane(b))) return json(400, "{\"error\":\"Those do not look like the two cookie values (a and b).\"}");
                FaNet.setFromWindow(a, b, null, null);
                persist();
                return json(200, status());
            }
            case "/fa/watch":
                if (post) { watchNames = null; open(WATCH, null, false); return json(200, "{\"ok\":true}"); }
                { JSONArray n = watchNames; watchNames = null; return json(200, "{\"names\":" + (n == null ? "null" : n.toString()) + "}"); }
            case "/fa/act":
                if (post) {
                    String user = args.optString("user", "").toLowerCase(java.util.Locale.ROOT);
                    if (!validUser(user)) return json(400, "{\"error\":\"bad user\"}");
                    actResult = null;
                    open(ACT, user, args.optBoolean("watch", true));
                    return json(200, "{\"ok\":true}");
                }
                { JSONObject r = actResult; actResult = null; return json(200, "{\"result\":" + (r == null ? "null" : r.toString()) + "}"); }
            case "/fa/disconnect":
                if (post) {
                    FaNet.clear(); persist();
                    UI.post(() -> { closeWin(); try { CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush(); } catch (RuntimeException ignored) { } });
                }
                return json(200, status());
            default: return json(404, "{\"error\":\"not found\"}");
        }
    }

    private static boolean validUser(String u) {
        if (u.isEmpty() || u.length() > 40) return false;
        for (int i = 0; i < u.length(); i++) {
            char c = u.charAt(i);
            if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && "_.~-".indexOf(c) < 0) return false;
        }
        return true;
    }

    /* ------------------------------------------------------------------ the window */
    private static void open(int mode, String user, boolean want) {
        UI.post(() -> {
            if (act == null || act.isFinishing()) return;
            closeWin();
            try { win = new Win(mode, user, want); } catch (RuntimeException e) { win = null; }
        });
    }

    private static void closeWin() {
        Win w = win;
        win = null;
        if (w != null) w.close();
    }

    /** Names read off the watch list's pages so far, the pages already visited, and whether the site's own watch link was followed. */
    private static final class Win {
        final int mode;
        final String user;
        final boolean want;
        final WebView web;
        Dialog dialog;
        final List<String> acc = new ArrayList<>();
        final Set<String> seen = new HashSet<>();
        boolean stepped, finished;
        int variant, page = 1;

        String guess(int vr, int pg) { return vr == 1 ? WWW + "controls/buddylist/?page=" + pg : WWW + "controls/buddylist/" + pg + "/"; }

        Win(int mode, String user, boolean want) {
            this.mode = mode; this.user = user; this.want = want;
            web = new WebView(act);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(web, true);
            web.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView v, String url) { probe(); }
            });
            if (mode != ACT) show();
            String start = mode == ACT ? WWW + "user/" + user + "/" : mode == WATCH ? WWW + "controls/buddylist/" : mode == LOGIN ? WWW + "login/" : WWW;
            web.loadUrl(start);
            if (mode == ACT) UI.postDelayed(() -> { if (win == this && !finished) fail("Fur Affinity did not answer in time"); }, 60_000);
        }

        void show() {
            if (dialog != null) { if (!dialog.isShowing()) dialog.show(); return; }
            dialog = new Dialog(act, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            LinearLayout col = new LinearLayout(act);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setBackgroundColor(0xFF0A1113);
            LinearLayout bar = new LinearLayout(act);
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            int pad = (int) (12 * act.getResources().getDisplayMetrics().density);
            bar.setPadding(pad, pad, pad, pad);
            TextView title = new TextView(act);
            title.setTextColor(Color.WHITE);
            title.setTextSize(16);
            title.setText(mode == WATCH ? "Fur Affinity: your watch list" : mode == ACT ? "Fur Affinity" : mode == LOGIN ? "Sign in to Fur Affinity" : "Fur Affinity: quick check");
            Button close = new Button(act);
            close.setText("Close");
            close.setOnClickListener(v -> closeWin());
            bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            bar.addView(close);
            col.addView(bar);
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            col.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            dialog.setContentView(col);
            dialog.setOnCancelListener(d -> closeWin());
            dialog.show();
        }

        void close() {
            if (!finished && mode == ACT && actResult == null) fail("Closed before it finished");
            finished = true;
            try { if (dialog != null) dialog.dismiss(); } catch (RuntimeException ignored) { }
            try { web.stopLoading(); web.destroy(); } catch (RuntimeException ignored) { }
            CookieManager.getInstance().flush();
            if (win == this) win = null;
        }

        void fail(String why) {
            if (finished) return;
            JSONObject o = new JSONObject();
            try { o.put("user", user == null ? "" : user).put("watching", !want).put("ok", false).put("error", why); } catch (Exception ignored) { }
            actResult = o;
            finished = true;
            closeWin();
        }

        void succeed() {
            JSONObject o = new JSONObject();
            try { o.put("user", user).put("watching", want).put("ok", true).put("error", ""); } catch (Exception ignored) { }
            actResult = o;
            finished = true;
            closeWin();
        }

        void probe() {
            web.evaluateJavascript(PROBE, raw -> {
                try {
                    Object v = new JSONTokener(raw == null ? "null" : raw).nextValue();
                    if (v instanceof String) info(new JSONObject((String) v));
                } catch (Exception ignored) { }
            });
        }

        void navigateLater(String url) {
            if (!url.startsWith(WWW)) return;
            UI.postDelayed(() -> { if (win == this && !finished) web.loadUrl(url); }, 1100);
        }

        /** What the page said about itself: the port of fa_handle_info in src/main.rs. */
        void info(JSONObject v) {
            if (finished || win != this) return;
            String host = v.optString("host", "");
            if (!host.endsWith("furaffinity.net")) return; // a captcha or sign-in provider: leave it alone
            String ck = CookieManager.getInstance().getCookie(WWW);
            String a = null, b = null, cf = null;
            if (ck != null) for (String part : ck.split(";")) {
                String p = part.trim();
                if (p.startsWith("a=")) a = p.substring(2);
                else if (p.startsWith("b=")) b = p.substring(2);
                else if (p.startsWith("cf_clearance=")) cf = p.substring(13);
            }
            if (FaNet.setFromWindow(a, b, cf, web.getSettings().getUserAgentString())) persist();
            String title = v.optString("title", "").toLowerCase(java.util.Locale.ROOT);
            boolean checking = title.startsWith("just a moment") || title.contains("attention required");
            String path = v.optString("path", "");
            if (mode == ACT) {
                if (checking || path.startsWith("/login")) { show(); return; } // the person has to deal with this one
                if (path.replaceAll("/+$", "").equalsIgnoreCase("/user/" + user)) {
                    JSONObject w = v.optJSONObject("w");
                    int state = w == null ? -1 : w.optInt("s", -1);
                    String link = w == null ? "" : w.optString("l", "");
                    if (state < 0) fail("Sign in to Fur Affinity first");
                    else if ((state == 1) == want) succeed();
                    else if (!stepped && (link.contains("/watch/") || link.contains("/unwatch/"))) { stepped = true; navigateLater(link); }
                    else fail("Fur Affinity did not change the watch");
                }
                return;
            }
            if (mode == WATCH) {
                JSONArray names = v.optJSONArray("names");
                boolean onList = path.startsWith("/controls/buddylist");
                if (onList && ((names != null && names.length() > 0) || !acc.isEmpty())) {
                    int before = acc.size();
                    if (names != null) for (int i = 0; i < names.length(); i++) { String n = names.optString(i); if (!n.isEmpty() && !acc.contains(n)) acc.add(n); }
                    boolean grew = acc.size() > before;
                    String next = v.optString("next", "");
                    // more pages, one request a second: the page's own next link, else the usual address forms (?page=2, then /2/) in turn
                    String go = null;
                    if (seen.size() < 100) {
                        if (grew && !next.isEmpty() && seen.add(next)) { variant = 0; go = next; }
                        else if (grew && next.isEmpty() && variant == 0 && acc.size() >= 20) { variant = 1; page = 2; go = guess(1, 2); }
                        else if (grew && variant > 0) { page++; go = guess(variant, page); }
                        else if (!grew && variant == 1 && page == 2) { variant = 2; page = 2; go = guess(2, 2); }
                    }
                    if (go != null) { seen.add(go); navigateLater(go); }
                    else finishWatch();
                } else if (!checking && !path.startsWith("/login") && !onList && FaNet.connected() && !stepped) {
                    stepped = true; // signed in but on some other page (just after signing in): go to the watch list once
                    web.loadUrl(WWW + "controls/buddylist/");
                }
                return;
            }
            boolean done = mode == LOGIN ? FaNet.connected() && !path.startsWith("/login") : !checking && cf != null;
            if (done) { finished = true; closeWin(); }
        }

        void finishWatch() {
            JSONArray out = new JSONArray();
            Set<String> uniq = new HashSet<>();
            for (String n : acc) {
                String l = n.toLowerCase(java.util.Locale.ROOT);
                if (l.length() <= 40 && validUser(l) && uniq.add(l) && out.length() < 5000) out.put(l);
            }
            watchNames = out;
            finished = true;
            closeWin();
        }
    }
}
