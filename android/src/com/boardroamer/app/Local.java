package com.boardroamer.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.media.ThumbnailUtils;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.util.Size;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * "Local" on the phone: the same three questions the desktop answers (src/local.rs): /local/list, /local/file and
 * /local/thumb, plus /local/config and /local/dirs for the settings. Read-only. Every request names a root (a folder you
 * chose) and a path inside it; anything that resolves outside the root is refused.
 *
 * Besides the page asking for its own files, this also (1) forwards /remote/<device>/... to the desktop or another phone with
 * the pairing code, and (2) when sharing is on, runs a tiny server so those devices can ask this phone the same questions.
 * Reading folders outside the app needs Android's "All files access", which the user grants from settings.
 */
final class Local {
    private Local() {}

    static final int PORT_FIRST = 4623;
    private static final int MAX_FILES = 6000;

    private static Context app;
    private static SharedPreferences prefs;
    private static volatile String hubUrl = "", code = "";
    private static volatile JSONObject remotes = new JSONObject(); // device name -> http://addr:port
    private static ServerSocket server;
    private static volatile int port = 0;
    private static Thread announcer;

    /** Reading picture sizes and embedded tags is the slow part of opening a folder, so it runs on several threads at once... */
    private static final ExecutorService POOL = Executors.newFixedThreadPool(8);
    /** ...and is remembered per file (path + size + modified time), on disk too, so the next visit is quick. */
    private static final Map<String, JSONObject> INFO = new ConcurrentHashMap<>();
    private static volatile boolean infoLoaded = false, infoDirty = false;

    private static void loadInfo() {
        if (infoLoaded) return;
        synchronized (INFO) {
            if (infoLoaded) return;
            try {
                File f = new File(app.getFilesDir(), "linfo.json");
                if (f.isFile()) {
                    JSONObject o = new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
                    java.util.Iterator<String> it = o.keys();
                    while (it.hasNext()) { String k = it.next(); INFO.put(k, o.getJSONObject(k)); }
                }
            } catch (Throwable ignored) { }
            infoLoaded = true;
        }
    }

    private static void saveInfoLater() {
        if (!infoDirty) return;
        infoDirty = false;
        POOL.submit(() -> {
            try {
                if (INFO.size() > 40000) INFO.clear();
                JSONObject o = new JSONObject();
                for (Map.Entry<String, JSONObject> e : INFO.entrySet()) o.put(e.getKey(), e.getValue());
                java.nio.file.Files.write(new File(app.getFilesDir(), "linfo.json").toPath(), o.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Throwable ignored) { }
        });
    }

    /** The answer to one request, before it is dressed up for the WebView or written to a socket. */
    static final class Out {
        int code = 200;
        String mime = "application/json";
        InputStream body;
        long length = -1;
        final Map<String, String> headers = new HashMap<>();
        Out(int code, String mime, byte[] b) { this.code = code; this.mime = mime; this.body = new ByteArrayInputStream(b); this.length = b.length; }
        Out(int code, String mime, InputStream in, long length) { this.code = code; this.mime = mime; this.body = in; this.length = length; }
    }

    private static Out json(int code, JSONObject o) { return new Out(code, "application/json", o.toString().getBytes(StandardCharsets.UTF_8)); }
    private static Out err(int code, String m) { try { return json(code, new JSONObject().put("error", m)); } catch (Exception e) { return new Out(code, "application/json", "{}".getBytes()); } }

    /* ------------------------------------------------------------------ setup */
    static synchronized void init(Context c) {
        if (app != null) return;
        app = c.getApplicationContext();
        prefs = app.getSharedPreferences("local", Context.MODE_PRIVATE);
        hubUrl = prefs.getString("hub", "");
        code = prefs.getString("code", "");
        applyShare();
        if (!hubUrl.isEmpty()) startAnnouncer();
    }

    static boolean access() {
        return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager();
    }

    static boolean sharing() { return prefs != null && prefs.getBoolean("share", false); }

    static void setHub(String url, String c) {
        hubUrl = url == null ? "" : url.replaceAll("/+$", "");
        code = c == null ? "" : c;
        if (prefs != null) prefs.edit().putString("hub", hubUrl).putString("code", code).apply();
        announce();
        startAnnouncer();
    }

    static void setRemotes(String json) {
        try {
            JSONObject o = new JSONObject(json);
            remotes = o.optJSONObject("devices") != null ? o.getJSONObject("devices") : new JSONObject();
            if (o.optString("hub").length() > 0) hubUrl = o.getString("hub").replaceAll("/+$", "");
            if (o.optString("code").length() > 0) code = o.getString("code");
            if (prefs != null) prefs.edit().putString("hub", hubUrl).putString("code", code).apply();
        } catch (Throwable ignored) { }
    }

    private static JSONArray roots() {
        try { return new JSONArray(prefs.getString("roots", "[]")); } catch (Throwable e) { return new JSONArray(); }
    }

    private static String rootPath(String id) {
        JSONArray a = roots();
        for (int i = 0; i < a.length(); i++) if (id.equals(a.optJSONObject(i).optString("id"))) return a.optJSONObject(i).optString("path");
        return null;
    }

    private static String idOf(String path) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.append(String.format(Locale.ROOT, "%02x", h[i]));
            return sb.toString();
        } catch (Exception e) { return Integer.toHexString(path.hashCode()); }
    }

    /* ------------------------------------------------------------------ what counts as media */
    private static String ext(String n) { int i = n.lastIndexOf('.'); return i < 0 ? "" : n.substring(i + 1).toLowerCase(Locale.ROOT); }

    private static String kind(String ext) {
        switch (ext) {
            case "jpg": case "jpeg": case "png": case "gif": case "webp": case "bmp": case "avif": case "jfif": case "heic": return "image";
            case "mp4": case "webm": case "mov": case "m4v": case "mkv": case "3gp": return "video";
            default: return null;
        }
    }

    private static String mime(String ext) {
        switch (ext) {
            case "jpg": case "jpeg": case "jfif": return "image/jpeg";
            case "png": return "image/png";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "bmp": return "image/bmp";
            case "avif": return "image/avif";
            case "heic": return "image/heic";
            case "mp4": case "m4v": return "video/mp4";
            case "webm": return "video/webm";
            case "mov": return "video/quicktime";
            case "mkv": return "video/x-matroska";
            case "3gp": return "video/3gpp";
            default: return "application/octet-stream";
        }
    }

    private static boolean hidden(String n) { return n.startsWith(".") || n.startsWith("$"); }

    /** A path inside the root, or null if it is not a plain path or resolves anywhere else. */
    private static File resolve(String root, String rel) {
        try {
            String rp = rootPath(root);
            if (rp == null) return null;
            File base = new File(rp).getCanonicalFile();
            File f = base;
            for (String part : rel.split("/")) {
                if (part.isEmpty()) continue;
                if (part.equals("..") || part.equals(".") || part.contains("\\") || part.contains(":")) return null;
                f = new File(f, part);
            }
            f = f.getCanonicalFile();
            String b = base.getPath(), p = f.getPath();
            return p.equals(b) || p.startsWith(b + File.separator) ? f : null;
        } catch (IOException e) { return null; }
    }

    /* ------------------------------------------------------------------ routes */
    static Out serve(String path, Uri q, String range) {
        try {
            switch (path) {
                case "/local/list": return list(q);
                case "/local/file": return file(q, range);
                case "/local/thumb": return thumb(q, range);
                default: return err(404, "not found");
            }
        } catch (Throwable e) {
            return err(500, String.valueOf(e.getMessage()));
        }
    }

    /** The page's own settings routes (never offered to other devices). */
    static Out own(String path, Uri q, String range) {
        try {
            if (prefs == null) return err(503, "not ready");
            if (path.equals("/local/config")) return config(q);
            if (path.equals("/local/dirs")) return dirs(q);
            return serve(path, q, range);
        } catch (Throwable e) {
            return err(500, String.valueOf(e.getMessage()));
        }
    }

    /** One file's line in a listing: name, size, picture size, and the tags Board Roamer (or another tool) embedded in it. */
    private static JSONObject fileInfo(File k) throws Exception {
        String n = k.getName(), e = ext(n), kd = kind(e);
        String key = k.getPath() + "|" + k.length() + "|" + k.lastModified();
        JSONObject c = INFO.get(key);
        if (c == null) {
            c = new JSONObject();
            int w = 0, h = 0;
            if (kd.equals("image")) {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(k.getPath(), o);
                w = Math.max(0, o.outWidth);
                h = Math.max(0, o.outHeight);
                if (e.equals("jpg") || e.equals("jpeg")) {
                    try { int ori = new ExifInterface(k.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1); if (ori >= 5 && ori <= 8) { int t = w; w = h; h = t; } } catch (Throwable ignored) { }
                }
            }
            c.put("w", w).put("h", h);
            JSONObject m = MetaRead.read(k, e);
            if (m != null) c.put("meta", m);
            INFO.put(key, c);
            infoDirty = true;
        }
        JSONObject out = new JSONObject().put("name", n).put("kind", kd).put("ext", e).put("w", c.optInt("w")).put("h", c.optInt("h")).put("size", k.length()).put("mtime", k.lastModified() / 1000);
        if (c.has("meta")) out.put("meta", c.get("meta"));
        return out;
    }

    private static JSONObject folderInfo(File dir) throws Exception {
        int count = 0;
        ArrayList<String> images = new ArrayList<>();
        File[] kids = access() ? dir.listFiles() : null;
        if (kids != null) {
            int seen = 0;
            for (File k : kids) {
                if (++seen > 4000) break;
                String n = k.getName();
                if (hidden(n) || !k.isFile()) continue;
                String kd = kind(ext(n));
                if (kd == null) continue;
                count++;
                if (kd.equals("image")) images.add(n);
            }
        }
        Collections.sort(images);
        return new JSONObject().put("count", count).put("covers", new JSONArray(images.subList(0, Math.min(3, images.size()))));
    }

    private static Out list(Uri q) throws Exception {
        String root = nz(q.getQueryParameter("root")), rel = nz(q.getQueryParameter("path"));
        JSONArray folders = new JSONArray(), files = new JSONArray();
        if (root.isEmpty()) {
            JSONArray rs = roots();
            for (int i = 0; i < rs.length(); i++) {
                JSONObject r = rs.getJSONObject(i);
                File d = new File(r.getString("path"));
                if (!d.isDirectory()) continue;
                JSONObject info = folderInfo(d);
                folders.put(info.put("id", r.getString("id")).put("name", r.getString("name")));
            }
            return json(200, new JSONObject().put("roots", true).put("folders", folders).put("files", files));
        }
        File dir = resolve(root, rel);
        File[] kids = dir == null || !access() ? null : dir.listFiles();
        if (kids == null) return err(404, access() ? "cannot read this folder" : "Allow access to files in Settings > Local first");
        loadInfo();
        ArrayList<File> subs = new ArrayList<>(), media = new ArrayList<>();
        for (File k : kids) {
            String n = k.getName();
            if (hidden(n)) continue;
            if (k.isDirectory()) { subs.add(k); continue; }
            if (k.isFile() && media.size() < MAX_FILES && kind(ext(n)) != null) media.add(k);
        }
        Collections.sort(subs, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
        List<Callable<JSONObject>> jobs = new ArrayList<>();
        for (File k : media) jobs.add(() -> fileInfo(k));
        List<Callable<JSONObject>> subJobs = new ArrayList<>();
        for (File sdir : subs) subJobs.add(() -> folderInfo(sdir).put("name", sdir.getName()));
        List<Future<JSONObject>> fs = POOL.invokeAll(jobs), ss = POOL.invokeAll(subJobs);
        for (Future<JSONObject> f : ss) folders.put(f.get());
        for (Future<JSONObject> f : fs) files.put(f.get());
        saveInfoLater();
        return json(200, new JSONObject().put("roots", false).put("folders", folders).put("files", files));
    }

    private static Out file(Uri q, String range) throws Exception {
        File f = resolve(nz(q.getQueryParameter("root")), nz(q.getQueryParameter("path")));
        if (f == null || !f.isFile() || !access()) return err(404, "not found");
        String e = ext(f.getName());
        if (kind(e) == null) return err(403, "not a picture or video");
        long size = f.length(), start = 0, end = size - 1;
        int code = 200;
        if (range != null && range.startsWith("bytes=") && size > 0) {
            String r = range.substring(6).split(",")[0].trim();
            int dash = r.indexOf('-');
            try {
                String a = r.substring(0, dash).trim(), b = r.substring(dash + 1).trim();
                if (a.isEmpty()) { long n = Long.parseLong(b); start = Math.max(0, size - n); }
                else { start = Long.parseLong(a); if (!b.isEmpty()) end = Math.min(end, Long.parseLong(b)); }
                if (start >= size || start > end) { Out o = err(416, "bad range"); o.headers.put("Content-Range", "bytes */" + size); return o; }
                code = 206;
            } catch (NumberFormatException ex) { start = 0; end = size - 1; }
        }
        long len = size == 0 ? 0 : end - start + 1;
        FileInputStream in = new FileInputStream(f);
        if (start > 0) in.skip(start);
        Out o = new Out(code, mime(e), new Limited(in, len), len);
        o.headers.put("Accept-Ranges", "bytes");
        o.headers.put("Cache-Control", "private, max-age=600");
        if (code == 206) o.headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        return o;
    }

    private static Out thumb(Uri q, String range) throws Exception {
        File f = resolve(nz(q.getQueryParameter("root")), nz(q.getQueryParameter("path")));
        if (f == null || !f.isFile() || !access()) return err(404, "not found");
        String e = ext(f.getName()), kd = kind(e);
        if (kd == null) return err(403, "not a picture or video");
        int side = 480;
        try { side = Math.max(64, Math.min(2400, Integer.parseInt(nz(q.getQueryParameter("s"))))); } catch (NumberFormatException ignored) { }
        File dir = new File(app.getCacheDir(), "lthumbs");
        dir.mkdirs();
        File cached = new File(dir, idOf(f.getPath() + "|" + f.length() + "|" + f.lastModified() + "|" + side) + ".jpg");
        if (!cached.isFile()) {
            Bitmap bmp = kd.equals("video") ? videoFrame(f, side) : imageThumb(f, side);
            if (bmp == null) return kd.equals("image") ? file(q, range) : err(404, "no preview");
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(cached)) { bmp.compress(Bitmap.CompressFormat.JPEG, 82, out); }
            bmp.recycle();
        }
        Out o = new Out(200, "image/jpeg", new FileInputStream(cached), cached.length());
        o.headers.put("Cache-Control", "private, max-age=86400");
        return o;
    }

    private static Bitmap videoFrame(File f, int side) {
        try { return ThumbnailUtils.createVideoThumbnail(f, new Size(side, side), null); } catch (Throwable e) { return null; }
    }

    private static Bitmap imageThumb(File f, int side) {
        try {
            Bitmap fast = ThumbnailUtils.createImageThumbnail(f, new Size(side, side), null);
            if (fast != null) return fast;
        } catch (Throwable ignored) { /* fall back to decoding it ourselves */ }
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getPath(), o);
            if (o.outWidth <= 0) return null;
            int sample = 1;
            while (o.outWidth / (sample * 2) >= side && o.outHeight / (sample * 2) >= side) sample *= 2;
            BitmapFactory.Options d = new BitmapFactory.Options();
            d.inSampleSize = sample;
            Bitmap b = BitmapFactory.decodeFile(f.getPath(), d);
            if (b == null) return null;
            Matrix m = new Matrix();
            String e = ext(f.getName());
            if (e.equals("jpg") || e.equals("jpeg")) {
                try {
                    switch (new ExifInterface(f.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)) {
                        case 3: m.postRotate(180); break;
                        case 6: m.postRotate(90); break;
                        case 8: m.postRotate(270); break;
                        default: break;
                    }
                } catch (Throwable ignored) { }
            }
            float s = Math.min(1f, (float) side / Math.max(b.getWidth(), b.getHeight()));
            m.postScale(s, s);
            Bitmap out = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
            if (out != b) b.recycle();
            return out;
        } catch (Throwable t) { return null; }
    }

    /* ------------------------------------------------------------------ settings routes */
    private static Out config(Uri q) throws Exception {
        SharedPreferences.Editor ed = prefs.edit();
        boolean changed = false;
        String share = q.getQueryParameter("share"), add = q.getQueryParameter("add"), rm = q.getQueryParameter("remove");
        JSONArray rs = roots();
        if (add != null) {
            File d = new File(add);
            boolean have = false;
            for (int i = 0; i < rs.length(); i++) if (add.equals(rs.getJSONObject(i).optString("path"))) have = true;
            if (!have && d.isDirectory()) {
                String name = nz(q.getQueryParameter("name"));
                if (name.trim().isEmpty()) name = d.getName().isEmpty() ? "Storage" : d.getName();
                rs.put(new JSONObject().put("id", idOf(add)).put("name", name).put("path", add));
                changed = true;
            }
        }
        if (rm != null) {
            JSONArray keep = new JSONArray();
            for (int i = 0; i < rs.length(); i++) if (!rm.equals(rs.getJSONObject(i).optString("id"))) keep.put(rs.getJSONObject(i));
            rs = keep;
            changed = true;
        }
        if (changed) ed.putString("roots", rs.toString());
        if (share != null) ed.putBoolean("share", share.equals("1"));
        ed.apply();
        if (share != null) applyShare();
        JSONArray out = new JSONArray();
        for (int i = 0; i < rs.length(); i++) {
            JSONObject r = rs.getJSONObject(i);
            out.put(new JSONObject().put("id", r.getString("id")).put("name", r.getString("name")).put("path", r.getString("path")).put("ok", new File(r.getString("path")).isDirectory()));
        }
        JSONArray quick = new JSONArray();
        File ext = Environment.getExternalStorageDirectory();
        for (String n : new String[] { "DCIM", "Pictures", "Download", "Movies" }) {
            File d = new File(ext, n);
            if (d.isDirectory()) quick.put(new JSONObject().put("name", n).put("path", d.getPath()));
        }
        return json(200, new JSONObject().put("share", prefs.getBoolean("share", false)).put("roots", out).put("quick", quick).put("os", "android").put("needsAccess", !access()));
    }

    private static Out dirs(Uri q) throws Exception {
        String path = nz(q.getQueryParameter("path"));
        JSONArray places = new JSONArray(), dirs = new JSONArray();
        if (path.isEmpty()) {
            File ext = Environment.getExternalStorageDirectory();
            places.put(new JSONObject().put("name", "Internal storage").put("path", ext.getPath()));
            File[] vols = new File("/storage").listFiles();
            if (vols != null) for (File v : vols) if (v.isDirectory() && !v.getName().equals("emulated") && !v.getName().equals("self")) places.put(new JSONObject().put("name", "Card " + v.getName()).put("path", v.getPath()));
            return json(200, new JSONObject().put("path", "").put("parent", JSONObject.NULL).put("places", places).put("dirs", dirs));
        }
        File p = new File(path);
        File[] kids = access() && p.isDirectory() ? p.listFiles() : null;
        if (kids == null) return err(404, access() ? "cannot read this folder" : "Allow access to files first");
        ArrayList<File> ds = new ArrayList<>();
        for (File k : kids) if (k.isDirectory() && !hidden(k.getName())) ds.add(k);
        Collections.sort(ds, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
        for (File d : ds) dirs.put(new JSONObject().put("name", d.getName()).put("path", d.getPath()));
        String parent = p.getParent();
        return json(200, new JSONObject().put("path", p.getPath()).put("parent", parent == null ? "" : parent).put("dirs", dirs).put("places", places));
    }

    private static String nz(String s) { return s == null ? "" : s; }

    /* ------------------------------------------------------------------ the page's requests */
    static WebResourceResponse intercept(Uri u, String method, Map<String, String> headers) {
        String path = u.getPath() == null ? "" : u.getPath();
        String range = null;
        if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) if (e.getKey().equalsIgnoreCase("range")) range = e.getValue();
        Out o = path.startsWith("/remote/") ? remote(path, u, range) : own(path, u, range);
        Map<String, String> h = new HashMap<>(o.headers);
        h.put("Access-Control-Allow-Origin", "*");
        if (!h.containsKey("Cache-Control")) h.put("Cache-Control", "no-store");
        String reason = o.code == 206 ? "Partial Content" : o.code == 200 ? "OK" : o.code == 404 ? "Not Found" : o.code == 416 ? "Range Not Satisfiable" : o.code >= 500 ? "Error" : "Status";
        return new WebResourceResponse(o.mime, null, o.code, reason, h, o.body);
    }

    /* ------------------------------------------------------------------ another device's folders */
    private static Out remote(String path, Uri q, String range) {
        String rest = path.substring("/remote/".length());
        int slash = rest.indexOf('/');
        if (slash < 0) return err(404, "not found");
        String id = Uri.decode(rest.substring(0, slash)), tail = rest.substring(slash);
        if (!tail.equals("/local/list") && !tail.equals("/local/file") && !tail.equals("/local/thumb")) return err(404, "not found");
        String base = id.equals("hub") ? hubUrl : remotes.optString(id, "");
        if (base.isEmpty() || code.isEmpty()) return err(404, "that device is not reachable (is it sharing, and is Board Roamer open there?)");
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + tail + (q.getEncodedQuery() == null ? "" : "?" + q.getEncodedQuery())).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(40000);
            c.setRequestProperty("Authorization", "Bearer " + code);
            c.setRequestProperty("X-Device", deviceName());
            if (range != null) c.setRequestProperty("Range", range);
            int rc = c.getResponseCode();
            InputStream in = rc >= 400 ? c.getErrorStream() : c.getInputStream();
            String ct = c.getContentType();
            Out o = new Out(rc, ct == null ? "application/octet-stream" : ct.split(";")[0].trim(), in == null ? new ByteArrayInputStream(new byte[0]) : in, c.getContentLengthLong());
            for (String k : new String[] { "Content-Range", "Accept-Ranges" }) if (c.getHeaderField(k) != null) o.headers.put(k, c.getHeaderField(k));
            return o;
        } catch (Throwable e) {
            return err(502, "could not reach that device: " + e.getMessage());
        }
    }

    static String deviceName() { return Build.MANUFACTURER + " " + Build.MODEL; }

    /* ------------------------------------------------------------------ sharing: a tiny server for the other devices */
    static synchronized void applyShare() {
        boolean want = prefs != null && prefs.getBoolean("share", false);
        if (want && server == null) startServer();
        else if (!want && server != null) stopServer();
        // while sharing, a foreground service keeps the phone answering even with the app closed
        if (want && server != null) ShareService.start(app);
        else if (!want) ShareService.stop(app);
        announce();
    }

    /** The "Stop sharing" button on the service's notification. */
    static void stopSharing() {
        if (prefs != null) prefs.edit().putBoolean("share", false).apply();
        applyShare();
    }

    private static void startServer() {
        for (int p = PORT_FIRST; p < PORT_FIRST + 20; p++) {
            try {
                server = new ServerSocket(p);
                port = p;
                break;
            } catch (IOException ignored) { }
        }
        if (server == null) return;
        final ServerSocket s = server;
        Thread t = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    final Socket c = s.accept();
                    new Thread(() -> handleSocket(c), "br-local-conn").start();
                } catch (IOException e) { break; }
            }
        }, "br-local-server");
        t.setDaemon(true);
        t.start();
    }

    private static void stopServer() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        server = null;
        port = 0;
    }

    private static String norm(String s) { return s == null ? "" : s.replaceAll("[^A-Za-z0-9]", "").toUpperCase(Locale.ROOT); }

    private static void handleSocket(Socket c) {
        try (Socket sock = c) {
            sock.setSoTimeout(15000);
            InputStream in = sock.getInputStream();
            StringBuilder head = new StringBuilder();
            int b;
            while ((b = in.read()) >= 0 && head.length() < 16384) {
                head.append((char) b);
                int n = head.length();
                if (n >= 4 && head.charAt(n - 1) == '\n' && head.charAt(n - 2) == '\r' && head.charAt(n - 3) == '\n' && head.charAt(n - 4) == '\r') break;
            }
            String[] lines = head.toString().split("\r?\n");
            String[] req = lines[0].split(" ");
            Out o;
            if (req.length < 2 || !req[0].equals("GET")) o = err(405, "method not allowed");
            else {
                String auth = "", range = null;
                for (String l : lines) {
                    int i = l.indexOf(':');
                    if (i <= 0) continue;
                    String k = l.substring(0, i).trim().toLowerCase(Locale.ROOT), v = l.substring(i + 1).trim();
                    if (k.equals("authorization")) auth = v.startsWith("Bearer ") ? v.substring(7) : v;
                    else if (k.equals("range")) range = v;
                }
                Uri u = Uri.parse("http://x" + req[1]);
                if (!sharing() || code.isEmpty() || !norm(auth).equals(norm(code))) o = err(401, "wrong pairing code");
                else if (!access()) o = err(403, "this phone has not allowed access to files");
                else o = serve(u.getPath() == null ? "" : u.getPath(), u, range);
            }
            OutputStream out = sock.getOutputStream();
            StringBuilder sb = new StringBuilder("HTTP/1.1 " + o.code + " " + (o.code == 200 ? "OK" : o.code == 206 ? "Partial Content" : "Status") + "\r\n");
            sb.append("Content-Type: ").append(o.mime).append("\r\nConnection: close\r\nCache-Control: no-store\r\n");
            if (o.length >= 0) sb.append("Content-Length: ").append(o.length).append("\r\n");
            for (Map.Entry<String, String> e : o.headers.entrySet()) sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            sb.append("\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            byte[] buf = new byte[32768];
            int r;
            while (o.body != null && (r = o.body.read(buf)) > 0) out.write(buf, 0, r);
            out.flush();
            if (o.body != null) o.body.close();
        } catch (Throwable ignored) { /* the other side hung up */ }
    }

    /* ------------------------------------------------------------------ telling the desktop where this phone listens */
    private static void announce() {
        final String url = hubUrl, c = code;
        if (url.isEmpty() || c.isEmpty()) return;
        final boolean share = port > 0 && sharing();
        final int p = port;
        new Thread(() -> {
            HttpURLConnection h = null;
            try {
                h = (HttpURLConnection) new URL(url + "/sync/device").openConnection();
                h.setConnectTimeout(4000);
                h.setReadTimeout(6000);
                h.setRequestMethod("POST");
                h.setRequestProperty("Authorization", "Bearer " + c);
                h.setRequestProperty("X-Device", deviceName());
                byte[] body = new JSONObject().put("port", p).put("share", share).toString().getBytes(StandardCharsets.UTF_8);
                h.setDoOutput(true);
                h.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = h.getOutputStream()) { os.write(body); }
                h.getResponseCode();
            } catch (Throwable ignored) { /* the desktop is not around right now */ }
            finally { if (h != null) h.disconnect(); }
        }, "br-local-announce").start();
    }

    private static synchronized void startAnnouncer() {
        if (announcer != null) return;
        announcer = new Thread(() -> {
            while (true) {
                try { Thread.sleep(60_000); } catch (InterruptedException e) { return; }
                announce();
            }
        }, "br-local-announcer");
        announcer.setDaemon(true);
        announcer.start();
    }

    /** Reads at most `left` bytes, then reports the end (so a ranged answer stops where the range does). */
    private static final class Limited extends InputStream {
        private final InputStream in;
        private long left;
        Limited(InputStream in, long left) { this.in = in; this.left = left; }
        @Override public int read() throws IOException { if (left <= 0) return -1; int b = in.read(); if (b >= 0) left--; return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int r = in.read(b, off, (int) Math.min(len, left));
            if (r > 0) left -= r;
            return r;
        }
        @Override public void close() throws IOException { in.close(); }
    }
}
