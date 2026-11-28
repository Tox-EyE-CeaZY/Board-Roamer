package com.boardroamer.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Fur Affinity, the network side (the same rules as src/fa.rs and src/proxy.rs on desktop): only read-only pages that
 * robots.txt leaves open to automated clients (the allow-list in `pathAllowed`), at least a second between page
 * requests, the session cookies only on the page host, a Cloudflare check reported and never bypassed.
 * No Android classes in here, so it can be tested on a JVM. The session is kept by Fa.java.
 */
final class FaNet {
    private FaNet() {}

    static final String SITE = "furaffinity.net";
    static final long GAP_MS = 1000;

    static final class Page {
        final int code;
        final String contentType;
        final byte[] body;
        final Map<String, String> headers = new HashMap<>();
        Page(int code, String contentType, byte[] body) { this.code = code; this.contentType = contentType; this.body = body; }
    }

    static boolean isFa(String host) { return host != null && (host.equals(SITE) || host.endsWith("." + SITE)); }
    static boolean isPageHost(String host) { return SITE.equals(host) || "www.furaffinity.net".equals(host); }

    /** The read-only pages the app shows: front page, browse, a submission, a user, galleries, scraps, favorites, journals. */
    static boolean pathAllowed(String path) {
        String raw = path;
        int q = raw.indexOf('?'); if (q >= 0) raw = raw.substring(0, q);
        int h = raw.indexOf('#'); if (h >= 0) raw = raw.substring(0, h);
        String d;
        try { d = URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8").toLowerCase(Locale.ROOT); } catch (Exception e) { return false; }
        if (d.contains("..") || d.contains("\\")) return false;
        java.util.List<String> seg = new java.util.ArrayList<>();
        for (String s : d.split("/")) if (!s.isEmpty()) seg.add(s);
        int n = seg.size();
        if (n == 0) return true;
        String a = seg.get(0);
        switch (a) {
            case "browse": return n <= 4;
            case "view": return n == 2 && digits(seg.get(1));
            case "user": return n == 2 && !"history".equals(seg.get(1));
            case "gallery":
            case "scraps":
                if (n == 2 || n == 3) return true;
                if (a.equals("gallery") && n >= 4 && "folder".equals(seg.get(2)) && n <= 6) return digits(seg.get(3));
                return false;
            case "favorites": return n >= 2 && n <= 4;
            case "journals": return n == 2 || n == 3;
            case "journal": return n == 2;
            default: return false;
        }
    }

    private static boolean digits(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
        return true;
    }

    /** Cloudflare's "checking your browser" page rather than the site. */
    static boolean isChallenge(int code, boolean mitigated, byte[] body) {
        if (mitigated) return true;
        String head = new String(body, 0, Math.min(body.length, 6000), StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
        if (head.contains("<title>just a moment") || head.contains("cf-browser-verification") || head.contains("challenge-platform")) return true;
        return (code == 403 || code == 503) && (head.contains("cf-chl") || head.contains("attention required"));
    }

    /* ------------------------------------------------------------------ the session (kept by Fa.java) */
    private static String a = "", b = "", clearance = "", ua = "";
    private static long generation = 0;

    static boolean sane(String v) {
        if (v == null || v.isEmpty() || v.length() >= 512) return false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && "-_.%+=/~:".indexOf(c) < 0) return false;
        }
        return true;
    }

    static synchronized void load(String a_, String b_, String clearance_, String ua_) {
        a = a_ == null ? "" : a_; b = b_ == null ? "" : b_; clearance = clearance_ == null ? "" : clearance_; ua = ua_ == null ? "" : ua_;
        generation++;
    }

    /** What the sign-in window found; true when something changed. */
    static synchronized boolean setFromWindow(String a_, String b_, String clearance_, String ua_) {
        String ba = a, bb = b, bc = clearance, bu = ua;
        if (sane(a_) && sane(b_)) { a = a_; b = b_; }
        if (sane(clearance_)) clearance = clearance_;
        if (ua_ != null && !ua_.isEmpty()) ua = ua_.length() > 400 ? ua_.substring(0, 400) : ua_;
        boolean changed = !(ba.equals(a) && bb.equals(b) && bc.equals(clearance) && bu.equals(ua));
        if (changed) generation++;
        return changed;
    }

    static synchronized boolean connected() { return sane(a) && sane(b); }
    static synchronized boolean cleared() { return sane(clearance); }
    static synchronized boolean hasUa() { return !ua.isEmpty(); }
    static synchronized long generation() { return generation; }
    static synchronized void clear() { a = ""; b = ""; clearance = ""; ua = ""; generation++; }
    static synchronized String[] snapshot() { return new String[]{a, b, clearance, ua}; }

    static synchronized String cookieHeader() {
        StringBuilder sb = new StringBuilder();
        if (sane(a) && sane(b)) sb.append("a=").append(a).append("; b=").append(b);
        if (sane(clearance)) { if (sb.length() > 0) sb.append("; "); sb.append("cf_clearance=").append(clearance); }
        return sb.length() == 0 ? null : sb.toString();
    }

    static synchronized String userAgent() {
        if (ua.isEmpty() || ua.length() >= 400) return Net.DEFAULT_UA;
        for (int i = 0; i < ua.length(); i++) if (ua.charAt(i) < 32) return Net.DEFAULT_UA;
        return ua;
    }

    /* ------------------------------------------------------------------ pages */
    private static long lastAt = 0;

    private static void throttle() {
        long wait;
        synchronized (FaNet.class) {
            long now = System.nanoTime() / 1_000_000L;
            long at = Math.max(now, lastAt + GAP_MS);
            lastAt = at;
            wait = at - now;
        }
        if (wait > 0) {
            try { Thread.sleep(wait); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    private static byte[] readAll(InputStream in, long limit) throws IOException {
        if (in == null) return new byte[0];
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(32 * 1024);
            byte[] buf = new byte[32 * 1024];
            long total = 0;
            int n;
            while ((n = is.read(buf)) > 0) { out.write(buf, 0, n); total += n; if (total > limit) break; }
            return out.toByteArray();
        }
    }

    private static Page json(int code, String s) { return new Page(code, "application/json", s.getBytes(StandardCharsets.UTF_8)); }

    /** One page from furaffinity.net, GET only. Never throws. */
    static Page page(String method, String target) {
        String host = Net.hostOf(target);
        if (!isPageHost(host)) return json(403, "{\"error\":\"Fur Affinity pictures are fetched with /img\"}");
        String path = target.substring(target.indexOf(host) + host.length());
        if (!pathAllowed(path)) return json(403, "{\"error\":\"Fur Affinity asks automated apps not to open that page, so it opens in your browser instead.\",\"robots\":true}");
        if (!"GET".equals(method)) return json(405, "{\"error\":\"Board Roamer only reads from Fur Affinity\"}");
        throttle();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(15_000);
            c.setReadTimeout(25_000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", userAgent());
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml");
            String ck = cookieHeader();
            if (ck != null) c.setRequestProperty("Cookie", ck);
            int code = c.getResponseCode();
            byte[] data = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream(), 32L << 20);
            String ct = c.getContentType();
            boolean mitigated = "challenge".equalsIgnoreCase(c.getHeaderField("cf-mitigated"));
            if (isChallenge(code, mitigated, data)) {
                Page p = json(503, "{\"error\":\"Fur Affinity needs a quick check in a browser window\",\"challenge\":true}");
                p.headers.put("X-BR-FA", "challenge");
                return p;
            }
            Page p = new Page(code, ct == null ? "text/html" : ct, data);
            p.headers.put("X-BR-FA", "ok");
            p.headers.put("X-BR-Final", c.getURL().toString());
            return p;
        } catch (IOException e) {
            return json(502, "{\"error\":\"upstream failed\"}");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** A picture or file from one of FA's picture hosts, with FA's own Referer. The caller closes the connection. */
    static HttpURLConnection openImage(String target) throws IOException {
        String host = Net.hostOf(target);
        if (!isFa(host) || isPageHost(host)) throw new IOException("host not allowed");
        HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(40_000);
        c.setRequestProperty("User-Agent", Net.DEFAULT_UA);
        c.setRequestProperty("Referer", "https://www.furaffinity.net/");
        return c;
    }
}
