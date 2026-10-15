package com.boardroamer.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Downloads a release APK from this project's GitHub releases and checks it against the release's SHA256SUMS.txt. */
final class Updater {
    /** Keep in sync with ui/js/version.js */
    static final String REPO = "Tox-EyE-CeaZY/Board-Roamer";
    static final String PREFIX = "https://github.com/" + REPO + "/releases/download/";

    interface Progress { void percent(int p); }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "BoardRoamer-Android-Updater");
        int code = c.getResponseCode();
        if (code >= 400) throw new IOException("GitHub answered HTTP " + code);
        return c;
    }

    private static String expectedHash(String url) throws IOException {
        int slash = url.lastIndexOf('/');
        String asset = url.substring(slash + 1);
        HttpURLConnection c = open(url.substring(0, slash) + "/SHA256SUMS.txt");
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] t = new byte[4096];
            int n;
            while ((n = in.read(t)) > 0) b.write(t, 0, n);
            for (String line : new String(b.toByteArray(), StandardCharsets.UTF_8).split("\\r?\\n")) {
                String[] p = line.trim().split("\\s+");
                if (p.length >= 2 && p[1].replaceFirst("^\\*", "").equals(asset)) return p[0].toLowerCase(java.util.Locale.ROOT);
            }
        } finally {
            c.disconnect();
        }
        throw new IOException(asset + " is not in the release's checksum list");
    }

    /** Fetch the APK into `out`; throws if it does not match its published checksum. */
    static void fetch(String url, File out, Progress progress) throws Exception {
        if (!url.startsWith(PREFIX)) throw new IOException("That is not a release of this app");
        String want = expectedHash(url);
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream(); FileOutputStream o = new FileOutputStream(out)) {
            long total = c.getContentLengthLong(), got = 0;
            byte[] buf = new byte[64 * 1024];
            int n, last = -1;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
                o.write(buf, 0, n);
                got += n;
                if (total > 0 && progress != null) {
                    int pct = (int) (got * 100 / total);
                    if (pct != last) { last = pct; progress.percent(pct); }
                }
            }
        } finally {
            c.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        if (!hex.toString().equals(want)) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw new IOException("The download does not match its checksum, so it was thrown away");
        }
    }
}
