package com.boardroamer.app;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Talking to the paired computer ("the hub"): TLS that trusts exactly one certificate (the fingerprint from the QR code), pairing with
 * the one-time key, finding the computer on the network again by its id (mDNS / DNS-SD), and which addresses this phone has.
 * Mirrors src/sync.rs on the computer.
 */
final class Hub {
    private Hub() {}

    /** SHA-256 fingerprint (hex) of the paired computer's certificate. Set from Local.setHub. */
    static volatile String fp = "";

    private static final Map<String, SSLSocketFactory> FACTORIES = new ConcurrentHashMap<>();
    private static final HostnameVerifier ANY_HOST = (h, s) -> true; // the certificate is pinned, a name adds nothing

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    static String fingerprintOf(X509Certificate c) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(c.getEncoded()));
    }

    static String norm(String s) {
        StringBuilder sb = new StringBuilder();
        for (char ch : s.toCharArray()) if (Character.isLetterOrDigit(ch) && ch < 128) sb.append(Character.toUpperCase(ch));
        return sb.toString();
    }

    static String mac(byte[] key, String msg) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        return hex(m.doFinal(msg.getBytes(StandardCharsets.UTF_8)));
    }

    /** What this phone's folder server expects from the computer and from other phones: HMAC-SHA256(device token, "share"). */
    static String shareCode(String token) {
        try { return token == null || token.isEmpty() ? "" : mac(token.getBytes(StandardCharsets.UTF_8), "share"); } catch (Exception e) { return ""; }
    }

    /** Accepts exactly one certificate, or (when `want` is empty) any, remembering what it saw. */
    private static final class Pin implements X509TrustManager {
        final String want;
        volatile String seen = "";
        Pin(String want) { this.want = want == null ? "" : want.toLowerCase(Locale.ROOT); }
        @Override public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException { throw new CertificateException("no clients"); }
        @Override public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
            try {
                seen = fingerprintOf(chain[0]);
            } catch (Exception e) {
                throw new CertificateException(e);
            }
            if (!want.isEmpty() && !want.equals(seen)) throw new CertificateException("This is not the computer you paired with (its certificate changed)");
        }
        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    private static SSLSocketFactory factory(Pin pin) throws Exception {
        SSLContext c = SSLContext.getInstance("TLS");
        c.init(null, new TrustManager[] { pin }, new SecureRandom());
        return c.getSocketFactory();
    }

    private static SSLSocketFactory pinned(String want) throws Exception {
        SSLSocketFactory f = FACTORIES.get(want);
        if (f == null) { f = factory(new Pin(want)); FACTORIES.put(want, f); }
        return f;
    }

    /** Open a connection to the paired computer. Plain http is only for this phone's own folder server and the loopback. */
    static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        if (c instanceof HttpsURLConnection) {
            if (fp.isEmpty()) throw new Exception("This phone is not paired with a computer yet");
            ((HttpsURLConnection) c).setSSLSocketFactory(pinned(fp));
            ((HttpsURLConnection) c).setHostnameVerifier(ANY_HOST);
        }
        return c;
    }

    /* ------------------------------------------------------------------ pairing */
    /** Ask `host:port` for its certificate fingerprint without trusting it (the pairing proofs decide whether it is the right one). */
    private static String peek(String host, int port) throws Exception {
        Pin pin = new Pin("");
        SSLSocketFactory f = factory(pin);
        try (SSLSocket s = (SSLSocket) f.createSocket()) {
            s.connect(new java.net.InetSocketAddress(host, port), 4000);
            s.setSoTimeout(5000);
            s.startHandshake();
        }
        if (pin.seen.isEmpty()) throw new Exception("No certificate");
        return pin.seen;
    }

    /**
     * Pair with a computer. req: {urls: ["host:port", ...], key, fp (optional: from the QR code), device}.
     * The key is never sent: the phone sends an HMAC over a nonce and the fingerprint it saw, and checks the computer's HMAC back.
     * Answer: {id, token, host, hostId, port, fp, url, addrs}.
     */
    static JSONObject pair(JSONObject req) throws Exception {
        String key = req.getString("key"), want = req.optString("fp", "").toLowerCase(Locale.ROOT), device = req.optString("device", "a phone");
        JSONArray targets = req.getJSONArray("urls");
        Exception last = null;
        for (int i = 0; i < targets.length(); i++) {
            String t = targets.getString(i).replaceFirst("^https?://", "");
            int c = t.lastIndexOf(':');
            if (c < 0) continue;
            String host = t.substring(0, c);
            int port;
            try { port = Integer.parseInt(t.substring(c + 1)); } catch (NumberFormatException e) { continue; }
            if (!Bridge.privateHost(host)) continue;
            try {
                String seen = peek(host, port);
                if (!want.isEmpty() && !want.equals(seen)) throw new Exception("That is not the computer in the code (its certificate is different)");
                byte[] nonceB = new byte[16];
                new SecureRandom().nextBytes(nonceB);
                String nonce = hex(nonceB);
                byte[] k = norm(key).getBytes(StandardCharsets.UTF_8);
                String body = new JSONObject().put("nonce", nonce).put("proof", mac(k, "pair-c|" + nonce + "|" + seen)).put("device", device).toString();
                HttpsURLConnection h = (HttpsURLConnection) new URL("https://" + host + ":" + port + "/sync/pair").openConnection();
                h.setSSLSocketFactory(pinned(seen));
                h.setHostnameVerifier(ANY_HOST);
                h.setConnectTimeout(5000);
                h.setReadTimeout(15000);
                h.setRequestMethod("POST");
                byte[] b = body.getBytes(StandardCharsets.UTF_8);
                h.setDoOutput(true);
                h.setFixedLengthStreamingMode(b.length);
                try (OutputStream os = h.getOutputStream()) { os.write(b); }
                int code = h.getResponseCode();
                java.io.InputStream in = code >= 400 ? h.getErrorStream() : h.getInputStream();
                String txt = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
                h.disconnect();
                JSONObject a = txt.isEmpty() ? new JSONObject() : new JSONObject(txt);
                if (code >= 400) throw new Exception(a.optString("error", "Pairing failed (" + code + ")"));
                String token = a.getString("token");
                if (!mac(k, "pair-h|" + nonce + "|" + seen + "|" + token).equals(a.optString("proof"))) throw new Exception("That computer could not prove it made the code. Nothing was paired.");
                a.put("fp", seen).put("url", "https://" + host + ":" + port);
                a.remove("proof");
                return a;
            } catch (Exception e) {
                last = e;
            }
        }
        throw last != null ? last : new Exception("Could not reach the computer. Are you on the same Wi-Fi?");
    }

    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        byte[] t = new byte[4096];
        int n;
        while ((n = in.read(t)) > 0) { o.write(t, 0, n); if (o.size() > 1 << 20) break; }
        in.close();
        return o.toByteArray();
    }

    /* ------------------------------------------------------------------ finding computers on the network */
    /** Looks for Board Roamer computers for `ms` milliseconds. Answer: [{id, name, fp, host, port}] (fp is only the first 16 digits). */
    static JSONArray discover(Context ctx, int ms) {
        final JSONArray out = new JSONArray();
        final NsdManager nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) return out;
        final LinkedBlockingQueue<NsdServiceInfo> queue = new LinkedBlockingQueue<>();
        final NsdManager.DiscoveryListener dl = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int e) { }
            @Override public void onStopDiscoveryFailed(String t, int e) { }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceFound(NsdServiceInfo i) { if (i.getServiceName() != null && i.getServiceName().startsWith("br-")) queue.offer(i); }
            @Override public void onServiceLost(NsdServiceInfo i) { }
        };
        try {
            nsd.discoverServices("_boardroamer._tcp", NsdManager.PROTOCOL_DNS_SD, dl);
        } catch (Throwable e) {
            return out;
        }
        long end = System.currentTimeMillis() + ms;
        final List<String> seenIds = new ArrayList<>();
        try {
            while (System.currentTimeMillis() < end) {
                NsdServiceInfo i = queue.poll(250, TimeUnit.MILLISECONDS);
                if (i == null) continue;
                final CountDownLatch done = new CountDownLatch(1);
                final NsdServiceInfo[] got = new NsdServiceInfo[1];
                try {
                    nsd.resolveService(i, new NsdManager.ResolveListener() {
                        @Override public void onResolveFailed(NsdServiceInfo s, int e) { done.countDown(); }
                        @Override public void onServiceResolved(NsdServiceInfo s) { got[0] = s; done.countDown(); }
                    });
                } catch (Throwable e) {
                    continue;
                }
                done.await(Math.max(500, end - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
                NsdServiceInfo s = got[0];
                if (s == null) continue;
                Map<String, byte[]> at = s.getAttributes();
                String id = at.get("id") == null ? "" : new String(at.get("id"), StandardCharsets.UTF_8);
                if (id.isEmpty() || seenIds.contains(id)) continue;
                InetAddress addr = s.getHost();
                if (addr == null) continue;
                seenIds.add(id);
                out.put(new JSONObject().put("id", id)
                    .put("name", at.get("name") == null ? "Board Roamer" : new String(at.get("name"), StandardCharsets.UTF_8))
                    .put("fp", at.get("fp") == null ? "" : new String(at.get("fp"), StandardCharsets.UTF_8))
                    .put("host", addr.getHostAddress()).put("port", s.getPort()));
            }
        } catch (Throwable ignored) {
        } finally {
            try { nsd.stopServiceDiscovery(dl); } catch (Throwable ignored) { }
        }
        return out;
    }

    /** This phone's own IPv4 addresses, and whether one of them is a Tailscale one (100.64.0.0/10). */
    static JSONObject netInfo() {
        JSONArray addrs = new JSONArray();
        boolean tailscale = false;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String ip = a.getHostAddress();
                    String[] p = ip.split("\\.");
                    boolean ts = p.length == 4 && p[0].equals("100") && Integer.parseInt(p[1]) >= 64 && Integer.parseInt(p[1]) <= 127;
                    tailscale |= ts;
                    addrs.put(new JSONObject().put("ip", ip).put("tailscale", ts));
                }
            }
        } catch (Throwable ignored) { }
        try { return new JSONObject().put("addrs", addrs).put("tailscale", tailscale); } catch (Exception e) { return new JSONObject(); }
    }
}
