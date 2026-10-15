package com.boardroamer.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The same job the desktop app's local server does: talk to the booru APIs on the page's behalf, politely.
 * Only allow-listed hosts, a per-host rate limit (e621 asks for 2 requests/second at most), a short response
 * cache, a custom User-Agent and Basic-auth passthrough. No Android classes in here, so it can be tested on a JVM.
 */
final class Net {
    private Net() {}

    static final String DEFAULT_UA = "BoardRoamer/0.1 (Android personal viewer)";
    private static final String[] ALLOWED = {"e621.net", "e926.net", "donmai.us", "gelbooru.com", "safebooru.org", "rule34.xxx", "konachan.com", "konachan.net", "yande.re"};
    private static final long CACHE_TTL_MS = 60_000;

    static final class Resp {
        final int code;
        final String contentType;
        final byte[] body;
        Resp(int code, String contentType, byte[] body) { this.code = code; this.contentType = contentType; this.body = body; }
    }

    /* ------------------------------------------------------------------ rules */
    static String hostOf(String url) {
        try {
            URI u = new URI(url);
            if (u.getUserInfo() != null || u.getHost() == null) return null;
            String scheme = u.getScheme();
            if (!"https".equals(scheme) && !"http".equals(scheme)) return null;
            return u.getHost().toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean allowed(String host) {
        if (host == null) return false;
        for (String a : ALLOWED) if (host.equals(a) || host.endsWith("." + a)) return true;
        return false;
    }

    static String referer(String host) {
        if (host.endsWith("e621.net") || host.endsWith("e926.net")) return "https://e621.net/";
        if (host.endsWith("donmai.us")) return "https://danbooru.donmai.us/";
        if (host.endsWith("gelbooru.com")) return "https://gelbooru.com/";
        return "https://safebooru.org/";
    }

    /* ------------------------------------------------------------------ rate limiting: GCRA with a burst of one extra request */
    private static final Map<String, Long> SLOTS = new HashMap<>();

    private static synchronized long reserve(String host, long gap) {
        long now = System.nanoTime() / 1_000_000L;
        Long t = SLOTS.get(host);
        long tat = (t != null && t > now) ? t : now;
        SLOTS.put(host, tat + gap);
        return Math.max(0, (tat - gap) - now);
    }

    static void throttle(String host) {
        long gap = (host.endsWith("e621.net") || host.endsWith("e926.net")) ? 520 : 150;
        long wait = reserve(host, gap);
        if (wait > 0) {
            try { Thread.sleep(wait); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
    }

    /* ------------------------------------------------------------------ cache */
    private static final Map<String, Object[]> CACHE = new LinkedHashMap<String, Object[]>(64, 0.75f, false) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Object[]> e) { return size() > 300; }
    };

    private static synchronized Resp cached(String key) {
        Object[] e = CACHE.get(key);
        if (e == null) return null;
        if (System.currentTimeMillis() - (Long) e[0] > CACHE_TTL_MS) { CACHE.remove(key); return null; }
        return (Resp) e[1];
    }

    private static synchronized void remember(String key, Resp r) {
        CACHE.put(key, new Object[]{System.currentTimeMillis(), r});
    }

    /* ------------------------------------------------------------------ API calls */
    private static byte[] readAll(InputStream in, long limit) throws IOException {
        if (in == null) return new byte[0];
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(16 * 1024);
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = is.read(buf)) > 0) {
                out.write(buf, 0, n);
                total += n;
                if (total > limit) break;
            }
            return out.toByteArray();
        }
    }

    private static Resp error(int code, String msg) {
        String json = "{\"error\":\"" + msg.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ") + "\"}";
        return new Resp(code, "application/json", json.getBytes(StandardCharsets.UTF_8));
    }

    /** One API request. Never throws: failures come back as a JSON error with a status code, like the desktop server. */
    static Resp api(String method, String target, String ua, String auth, byte[] body) {
        String host = hostOf(target);
        if (host == null) return error(400, "bad url");
        if (!allowed(host)) return error(403, "host not allowed");
        String key = target + "|" + (auth == null ? "" : auth);
        boolean get = "GET".equals(method);
        if (get) {
            Resp c = cached(key);
            if (c != null) return c;
        }
        throttle(host);
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(15_000);
            c.setReadTimeout(25_000);
            c.setRequestMethod(method);
            c.setRequestProperty("User-Agent", ua == null || ua.isEmpty() ? DEFAULT_UA : ua);
            c.setRequestProperty("Accept", "application/json");
            if (auth != null && !auth.isEmpty()) c.setRequestProperty("Authorization", auth);
            if ("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) {
                byte[] b = body == null ? new byte[0] : body;
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(b.length);
                if (b.length > 0) c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (OutputStream o = c.getOutputStream()) { o.write(b); }
            }
            int code = c.getResponseCode();
            byte[] data = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream(), 32L << 20);
            String ct = c.getContentType();
            Resp r = new Resp(code, ct == null ? "application/octet-stream" : ct, data);
            if (get && code == 200) remember(key, r);
            return r;
        } catch (IOException e) {
            return error(502, "upstream failed: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /* ------------------------------------------------------------------ images / downloads (send the site's own Referer) */
    static HttpURLConnection openImage(String target) throws IOException {
        String host = hostOf(target);
        if (!allowed(host)) throw new IOException("host not allowed");
        HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(40_000);
        c.setRequestProperty("User-Agent", DEFAULT_UA);
        c.setRequestProperty("Referer", referer(host));
        return c;
    }

    /** Stream a file to disk. Used for saves and shares. */
    static void download(String target, String ua, File out) throws IOException {
        String host = hostOf(target);
        if (!allowed(host)) throw new IOException("host not allowed");
        throttle(host);
        HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
        try {
            c.setConnectTimeout(15_000);
            c.setReadTimeout(120_000);
            c.setRequestProperty("User-Agent", ua == null || ua.isEmpty() ? DEFAULT_UA : ua);
            c.setRequestProperty("Referer", referer(host));
            int code = c.getResponseCode();
            if (code >= 400) throw new IOException("HTTP " + code);
            try (InputStream in = c.getInputStream(); FileOutputStream o = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            }
        } finally {
            c.disconnect();
        }
    }
}
