package com.boardroamer.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Downloads a file, writes its metadata into it, and files it under Downloads/Board Roamer (MediaStore). */
final class Saver {
    private Saver() {}

    static String sanitize(String name) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < name.length() && sb.length() < 150; i++) {
            char c = name.charAt(i);
            sb.append(Character.isLetterOrDigit(c) || "-_. ()+".indexOf(c) >= 0 ? c : '_');
        }
        String s = sb.toString().trim();
        while (s.startsWith(".")) s = s.substring(1);
        return s.isEmpty() ? "download" : s;
    }

    static String ext(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    static String mime(String ext) {
        switch (ext) {
            case "jpg": case "jpeg": return "image/jpeg";
            case "png": return "image/png";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "mp4": case "m4v": return "video/mp4";
            case "webm": return "video/webm";
            case "json": return "application/json";
            case "xmp": return "text/xml";
            case "swf": return "application/x-shockwave-flash";
            case "apk": return "application/vnd.android.package-archive";
            default: return "application/octet-stream";
        }
    }

    private static byte[] readFile(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(f.length() + 1, 64L << 20));
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static String relPath(String dir) {
        return "Download/Board Roamer" + (dir == null || dir.trim().isEmpty() ? "" : "/" + sanitize(dir));
    }

    static Uri insertFile(Context ctx, String displayName, String mime, String rel, File src) throws IOException {
        ContentResolver r = ctx.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IOException("could not create the file in Downloads");
        try (OutputStream o = r.openOutputStream(uri); InputStream in = new FileInputStream(src)) {
            if (o == null) throw new IOException("could not open the new file");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        } catch (IOException e) {
            r.delete(uri, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        r.update(uri, v, null, null);
        return uri;
    }

    static Uri insertBytes(Context ctx, String displayName, String mime, String rel, byte[] data) throws IOException {
        File tmp = File.createTempFile("txt", ".tmp", ctx.getCacheDir());
        try {
            try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); }
            return insertFile(ctx, displayName, mime, rel, tmp);
        } finally {
            tmp.delete();
        }
    }

    /** Result: {path (a content:// uri the page can hand back to reveal()), meta: embedded | sidecar | none | off, name}. */
    static JSONObject save(Context ctx, String url, String name, String dir, String metaJson, String ua) throws Exception {
        String safe = sanitize(name), ext = ext(safe);
        File tmp = File.createTempFile("save", "." + (ext.isEmpty() ? "bin" : ext), ctx.getCacheDir());
        try {
            Net.download(url, ua, tmp);
            JSONObject m = metaJson == null || metaJson.isEmpty() ? null : new JSONObject(metaJson);
            String state = m == null ? "off" : "none";
            if (m != null) {
                if (Meta.isImage(ext)) {
                    byte[] out = Meta.embedBytes(ext, readFile(tmp), m);
                    if (out != null) {
                        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(out); }
                        state = "embedded";
                    }
                } else if (Meta.embedFile(tmp, ext, m)) state = "embedded";
            }
            String rel = relPath(dir);
            Uri uri = insertFile(ctx, safe, mime(ext), rel, tmp);
            if ("none".equals(state)) {
                try {
                    insertBytes(ctx, safe + ".xmp", "text/xml", rel, Meta.xmp(m, Integer.MAX_VALUE).getBytes(StandardCharsets.UTF_8));
                    state = "sidecar";
                } catch (IOException ignored) { /* the file itself is saved; the sidecar is a bonus */ }
            }
            return new JSONObject().put("path", uri.toString()).put("meta", state).put("name", safe);
        } finally {
            tmp.delete();
        }
    }

    static String saveText(Context ctx, String name, String text, String type) throws IOException {
        String safe = sanitize(name);
        Uri uri = insertBytes(ctx, safe, type == null || type.isEmpty() ? mime(ext(safe)) : type, relPath(""), text.getBytes(StandardCharsets.UTF_8));
        return uri.toString();
    }
}
