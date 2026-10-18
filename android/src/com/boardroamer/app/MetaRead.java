package com.boardroamer.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads back what Meta.java (and the desktop app) wrote into a saved file: tags, artists and where it came from. Same
 * compact answer as src/meta.rs `read`, so the Local gallery shows tags for pictures that came from Board Roamer.
 * XMP is read from the head of images and WebM, the tail of MP4/MOV, or a `.xmp` sidecar next to the file.
 */
final class MetaRead {
    private MetaRead() {}

    private static final int HEAD = 96 * 1024, TAIL = 160 * 1024;

    static JSONObject read(File f, String ext) {
        try {
            long len = f.length();
            boolean tail = ext.equals("mp4") || ext.equals("m4v") || ext.equals("mov") || ext.equals("webm") || ext.equals("mkv"); // appended at the end of video files
            byte[] buf;
            try (FileInputStream in = new FileInputStream(f)) {
                if (len <= HEAD + TAIL) buf = all(in, len);
                else if (tail) { in.skip(len - TAIL); buf = all(in, TAIL); }
                else buf = all(in, HEAD);
            }
            if (ext.equals("webm") || ext.equals("mkv")) {
                JSONObject mk = mkvRecord(buf);
                if (mk != null) return mk;
            }
            String s = new String(buf, StandardCharsets.UTF_8);
            int a = s.indexOf("<x:xmpmeta");
            int b = a < 0 ? -1 : s.indexOf("</x:xmpmeta>", a);
            JSONObject m = a >= 0 && b > a ? parse(s.substring(a, b + 12)) : null;
            if (m != null) return m;
            File side = new File(f.getPath() + ".xmp");
            if (side.isFile() && side.length() < (1 << 20)) {
                try (FileInputStream in = new FileInputStream(side)) { return parse(new String(all(in, side.length()), StandardCharsets.UTF_8)); }
            }
        } catch (Throwable ignored) { }
        return null;
    }

    private static byte[] all(InputStream in, long max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(max, 1 << 20));
        byte[] b = new byte[32768];
        long left = max;
        int r;
        while (left > 0 && (r = in.read(b, 0, (int) Math.min(b.length, left))) > 0) { out.write(b, 0, r); left -= r; }
        return out.toByteArray();
    }

    private static String unesc(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
    }

    private static String between(String s, String a, String b) {
        int i = s.indexOf(a);
        if (i < 0) return null;
        i += a.length();
        int j = s.indexOf(b, i);
        return j < 0 ? null : s.substring(i, j);
    }

    private static List<String> items(String s, String tag) {
        List<String> out = new ArrayList<>();
        String block = between(s, "<" + tag + ">", "</" + tag + ">");
        if (block == null) return out;
        for (String part : block.split("<rdf:li")) {
            int gt = part.indexOf('>');
            int end = part.indexOf("</rdf:li>");
            if (gt < 0 || end < gt) continue;
            String v = unesc(part.substring(gt + 1, end));
            if (!v.isEmpty()) out.add(v);
        }
        return out;
    }

    private static JSONArray arr(JSONObject o, String k) {
        JSONArray a = o == null ? null : o.optJSONArray(k);
        return a == null ? new JSONArray() : a;
    }

    /** The same compact answer, from the full record (what the XMP's br:json or the Matroska tag holds). */
    private static JSONObject compact(JSONObject full) throws Exception {
        JSONObject out = new JSONObject();
        for (String k : new String[] { "site", "siteId", "id", "url", "md5", "rating", "score", "posted", "fullUrl" }) if (full.has(k) && !full.isNull(k)) out.put(k, full.get(k));
        out.put("artists", arr(full, "artists"));
        out.put("sources", arr(full, "sources"));
        out.put("tags", arr(full, "tags"));
        JSONObject c = full.optJSONObject("tagsByCategory");
        if (c != null) out.put("byCat", c);
        return out;
    }

    /** WebM / Matroska: a SimpleTag named BOARDROAMER_JSON, then [0x44 0x87][size][value]. */
    private static JSONObject mkvRecord(byte[] b) {
        try {
            byte[] name = "BOARDROAMER_JSON".getBytes(StandardCharsets.US_ASCII);
            int at = -1;
            outer:
            for (int i = 0; i + name.length < b.length; i++) {
                for (int k = 0; k < name.length; k++) if (b[i + k] != name[k]) continue outer;
                at = i + name.length;
                break;
            }
            if (at < 0 || at + 3 > b.length || (b[at] & 0xFF) != 0x44 || (b[at + 1] & 0xFF) != 0x87) return null;
            int first = b[at + 2] & 0xFF, w = 1;
            while (w <= 8 && (first & (0x80 >> (w - 1))) == 0) w++;
            long size = first & (0xFF >> w);
            for (int i = 1; i < w; i++) size = (size << 8) | (b[at + 2 + i] & 0xFF);
            int start = at + 2 + w;
            if (size <= 0 || start + size > b.length) return null;
            JSONObject out = compact(new JSONObject(new String(b, start, (int) size, StandardCharsets.UTF_8)));
            return out.optJSONArray("tags").length() > 0 || out.has("siteId") ? out : null;
        } catch (Throwable e) {
            return null;
        }
    }

    static JSONObject parse(String x) {
        try {
            JSONObject out = new JSONObject();
            String js = between(x, "<br:json>", "</br:json>");
            JSONObject full = null;
            if (js != null) { try { full = new JSONObject(unesc(js)); } catch (Throwable ignored) { } }
            if (full != null) {
                for (String k : new String[] { "site", "siteId", "id", "url", "md5", "rating", "score", "posted", "fullUrl" }) if (full.has(k) && !full.isNull(k)) out.put(k, full.get(k));
                out.put("artists", arr(full, "artists"));
                out.put("sources", arr(full, "sources"));
                out.put("tags", arr(full, "tags"));
                JSONObject c = full.optJSONObject("tagsByCategory");
                if (c != null) out.put("byCat", c);
            } else {
                List<String> tags = items(x, "dc:subject");
                if (tags.isEmpty()) {
                    String ts = between(x, "<br:tagString>", "</br:tagString>");
                    if (ts != null) for (String t : unesc(ts).trim().split("\\s+")) if (!t.isEmpty()) tags.add(t);
                }
                String[][] el = { { "site", "br:site" }, { "siteId", "br:siteId" }, { "id", "br:postId" }, { "url", "br:postUrl" }, { "md5", "br:md5" }, { "rating", "br:rating" } };
                for (String[] e : el) { String v = between(x, "<" + e[1] + ">", "</" + e[1] + ">"); if (v != null) out.put(e[0], unesc(v)); }
                out.put("artists", new JSONArray(items(x, "dc:creator")));
                out.put("sources", new JSONArray(items(x, "br:sources")));
                out.put("tags", new JSONArray(tags));
            }
            return out.optJSONArray("tags").length() > 0 || out.has("siteId") ? out : null;
        } catch (Throwable e) {
            return null;
        }
    }
}
