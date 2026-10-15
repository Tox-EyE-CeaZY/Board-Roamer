package com.boardroamer.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.zip.CRC32;

/**
 * Writes a post's metadata into the file that gets saved (artist, tags, source, post link, the site's MD5…).
 * XMP goes into JPEG / PNG / GIF / MP4 / WebM; JPEG also gets Windows-style EXIF tags, PNG plain text chunks and
 * GIF a comment. This is a port of the desktop app's src/meta.rs, and has no Android dependencies so it can be
 * unit-tested on a plain JVM. The picture / stream data itself is never touched.
 */
final class Meta {
    private Meta() {}

    private static final String NS_BR = "https://github.com/board-roamer/ns/1.0/";
    private static final byte[] XMP_HDR = "http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII);

    /* ------------------------------------------------------------------ helpers */
    static String esc(String s) {
        StringBuilder o = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': o.append("&amp;"); break;
                case '<': o.append("&lt;"); break;
                case '>': o.append("&gt;"); break;
                case '"': o.append("&quot;"); break;
                case '\'': o.append("&apos;"); break;
                default:
                    if (c < 0x20 && c != '\n' && c != '\t') break;
                    o.append(c);
            }
        }
        return o.toString();
    }

    static String text(JSONObject m, String k) {
        Object v = m.opt(k);
        if (v == null || v == JSONObject.NULL) return "";
        return v.toString();
    }

    static List<String> list(JSONObject m, String k) {
        List<String> out = new ArrayList<>();
        JSONArray a = m.optJSONArray(k);
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            Object v = a.opt(i);
            if (v instanceof String || v instanceof Number) out.add(v.toString());
        }
        return out;
    }

    static String title(JSONObject m) {
        List<String> a = list(m, "artists");
        String base = text(m, "site") + " #" + text(m, "id");
        if (a.isEmpty()) return base;
        return String.join(", ", a.subList(0, Math.min(3, a.size()))) + " — " + base;
    }

    private static byte[] ascii(String s) {
        byte[] b = new byte[s.length() + 1];
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            b[i] = (byte) ((c < 128 && c != 0) ? c : '?');
        }
        return b;
    }

    private static byte[] utf16z(String s) {
        byte[] u = s.getBytes(StandardCharsets.UTF_16LE);
        byte[] b = Arrays.copyOf(u, u.length + 2);
        return b;
    }

    private static byte[] latin1(String s) {
        byte[] b = new byte[s.length()];
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            b[i] = (byte) ((c < 256 && c != 0) ? c : '?');
        }
        return b;
    }

    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /* ------------------------------------------------------------------ XMP */
    private static String bag(String name, List<String> items, String kind) {
        if (items.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        sb.append('<').append(name).append("><rdf:").append(kind).append('>');
        for (String i : items) sb.append("<rdf:li>").append(esc(i)).append("</rdf:li>");
        sb.append("</rdf:").append(kind).append("></").append(name).append('>');
        return sb.toString();
    }

    private static String buildXmp(JSONObject m, List<String> tags, boolean withJson) {
        List<String> artists = list(m, "artists");
        List<String> sources = list(m, "sources");
        List<String> pools = list(m, "pools");
        String d = text(m, "desc");
        String desc = d.trim().isEmpty() ? title(m) + " · " + text(m, "url") : d;
        List<String> ident = Arrays.asList(text(m, "siteId") + ":" + text(m, "id"), "md5:" + text(m, "md5"));
        StringBuilder x = new StringBuilder();
        x.append("<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n");
        x.append("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
        x.append("<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:br=\"").append(NS_BR).append("\">\n");
        x.append("<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">").append(esc(title(m))).append("</rdf:li></rdf:Alt></dc:title>\n");
        x.append(bag("dc:creator", artists, "Seq"));
        x.append(bag("dc:subject", tags, "Bag"));
        x.append("<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">").append(esc(desc)).append("</rdf:li></rdf:Alt></dc:description>\n");
        x.append("<dc:source>").append(esc(text(m, "url"))).append("</dc:source>\n");
        x.append(bag("dc:identifier", ident, "Bag"));
        x.append("<xmp:CreatorTool>Board Roamer</xmp:CreatorTool>\n");
        String[][] fields = {{"site", "site"}, {"siteId", "siteId"}, {"postId", "id"}, {"md5", "md5"}, {"postUrl", "url"}, {"fileUrl", "fullUrl"},
                {"rating", "rating"}, {"score", "score"}, {"favorites", "favs"}, {"posted", "posted"}, {"parent", "parent"}};
        for (String[] f : fields) {
            String v = text(m, f[1]);
            if (!v.isEmpty()) x.append("<br:").append(f[0]).append('>').append(esc(v)).append("</br:").append(f[0]).append(">\n");
        }
        x.append(bag("br:sources", sources, "Bag"));
        x.append(bag("br:pools", pools, "Bag"));
        x.append("<br:tagString>").append(esc(String.join(" ", tags))).append("</br:tagString>\n");
        if (withJson) x.append("<br:json>").append(esc(m.toString())).append("</br:json>\n");
        x.append("</rdf:Description>\n</rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>");
        return x.toString();
    }

    /** An XMP packet no larger than {@code max} bytes: sheds the JSON blob first, then tags, if it must. */
    static String xmp(JSONObject m, int max) {
        List<String> tags = list(m, "tags");
        String full = buildXmp(m, tags, true);
        if (utf8(full).length <= max) return full;
        while (true) {
            String x = buildXmp(m, tags, false);
            if (utf8(x).length <= max || tags.isEmpty()) return x;
            tags = new ArrayList<>(tags.subList(0, tags.size() * 3 / 4));
        }
    }

    /* ------------------------------------------------------------------ JPEG */
    private static final class Ent {
        final int tag, type, count;
        final byte[] bytes;
        Ent(int tag, int type, byte[] bytes, int count) { this.tag = tag; this.type = type; this.bytes = bytes; this.count = count; }
    }

    private static byte[] exifBlock(JSONObject m) {
        String artists = String.join("; ", list(m, "artists"));
        String tags = String.join(";", list(m, "tags"));
        String ttl = title(m);
        String comment = text(m, "url") + " | " + text(m, "siteId") + " | md5:" + text(m, "md5");
        List<Ent> ents = new ArrayList<>();
        byte[] a = ascii(ttl);
        ents.add(new Ent(0x010E, 2, a, a.length));
        byte[] sw = ascii("Board Roamer");
        ents.add(new Ent(0x0131, 2, sw, sw.length));
        if (!artists.isEmpty()) {
            byte[] ar = ascii(artists);
            ents.add(new Ent(0x013B, 2, ar, ar.length));
        }
        Object[][] xp = {{0x9C9B, ttl}, {0x9C9C, comment}, {0x9C9D, artists}, {0x9C9E, tags}};
        for (Object[] e : xp) {
            String s = (String) e[1];
            if (s.isEmpty()) continue;
            byte[] b = utf16z(s);
            ents.add(new Ent((Integer) e[0], 1, b, b.length));
        }
        ents.sort((p, q) -> Integer.compare(p.tag, q.tag));
        int n = ents.size();
        ByteBuffer head = ByteBuffer.allocate(8 + 2 + n * 12 + 4).order(ByteOrder.LITTLE_ENDIAN);
        head.put((byte) 'I').put((byte) 'I').put((byte) 42).put((byte) 0).putInt(8).putShort((short) n);
        int base = 8 + 2 + n * 12 + 4;
        ByteArrayOutputStream tail = new ByteArrayOutputStream();
        for (Ent e : ents) {
            head.putShort((short) e.tag).putShort((short) e.type).putInt(e.count);
            if (e.bytes.length <= 4) {
                byte[] v = Arrays.copyOf(e.bytes, 4);
                head.put(v);
            } else {
                head.putInt(base + tail.size());
                tail.write(e.bytes, 0, e.bytes.length);
                if (e.bytes.length % 2 == 1) tail.write(0);
            }
        }
        head.putInt(0);
        ByteArrayOutputStream seg = new ByteArrayOutputStream();
        seg.write(new byte[]{'E', 'x', 'i', 'f', 0, 0}, 0, 6);
        seg.write(head.array(), 0, head.position());
        byte[] t = tail.toByteArray();
        seg.write(t, 0, t.length);
        return seg.toByteArray();
    }

    private static byte[] app1(byte[] payload) {
        int len = payload.length + 2;
        if (len > 0xFFFF) return null;
        ByteArrayOutputStream o = new ByteArrayOutputStream(len + 2);
        o.write(0xFF);
        o.write(0xE1);
        o.write(len >> 8);
        o.write(len & 0xFF);
        o.write(payload, 0, payload.length);
        return o.toByteArray();
    }

    private static boolean startsWith(byte[] b, int off, byte[] prefix) {
        if (off + prefix.length > b.length) return false;
        for (int i = 0; i < prefix.length; i++) if (b[off + i] != prefix[i]) return false;
        return true;
    }

    private static byte[] jpeg(byte[] b, JSONObject m) {
        if (b.length < 4 || (b[0] & 0xFF) != 0xFF || (b[1] & 0xFF) != 0xD8) return null;
        int i = 2;
        ByteArrayOutputStream app0 = new ByteArrayOutputStream(), kept = new ByteArrayOutputStream();
        boolean hasExif = false;
        while (i + 4 <= b.length && (b[i] & 0xFF) == 0xFF) {
            int mk = b[i + 1] & 0xFF;
            if (mk == 0xDA || mk == 0xD9 || mk == 0xD8 || (mk >= 0xD0 && mk <= 0xD7) || mk == 0x01) break;
            int len = ((b[i + 2] & 0xFF) << 8) | (b[i + 3] & 0xFF);
            int end = i + 2 + len;
            if (end > b.length || len < 2) return null;
            if (mk == 0xE0 && app0.size() == 0 && kept.size() == 0) {
                app0.write(b, i, end - i);
            } else if (mk == 0xE1 && startsWith(b, i + 4, XMP_HDR)) {
                // an older XMP packet: replaced by ours
            } else {
                if (mk == 0xE1 && startsWith(b, i + 4, new byte[]{'E', 'x', 'i', 'f', 0, 0})) hasExif = true;
                kept.write(b, i, end - i);
            }
            i = end;
        }
        byte[] x = utf8(xmp(m, 65000 - XMP_HDR.length));
        byte[] payload = new byte[XMP_HDR.length + x.length];
        System.arraycopy(XMP_HDR, 0, payload, 0, XMP_HDR.length);
        System.arraycopy(x, 0, payload, XMP_HDR.length, x.length);
        byte[] xmpSeg = app1(payload);
        if (xmpSeg == null) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream(b.length + xmpSeg.length + 2048);
        out.write(0xFF);
        out.write(0xD8);
        out.write(app0.toByteArray(), 0, app0.size());
        if (!hasExif) {
            byte[] e = app1(exifBlock(m));
            if (e != null) out.write(e, 0, e.length);
        }
        out.write(xmpSeg, 0, xmpSeg.length);
        out.write(kept.toByteArray(), 0, kept.size());
        out.write(b, i, b.length - i);
        return out.toByteArray();
    }

    /* ------------------------------------------------------------------ PNG */
    private static byte[] pngChunk(String type, byte[] data) {
        ByteBuffer bb = ByteBuffer.allocate(data.length + 12);
        bb.putInt(data.length);
        byte[] t = type.getBytes(StandardCharsets.US_ASCII);
        bb.put(t).put(data);
        CRC32 crc = new CRC32();
        crc.update(t, 0, 4);
        crc.update(data, 0, data.length);
        bb.putInt((int) crc.getValue());
        return bb.array();
    }

    private static byte[] cat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] o = new byte[n];
        int k = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, o, k, p.length); k += p.length; }
        return o;
    }

    private static byte[] pngText(String k, String v) {
        return pngChunk("tEXt", cat(k.getBytes(StandardCharsets.US_ASCII), new byte[]{0}, latin1(v)));
    }

    private static byte[] png(byte[] b, JSONObject m) {
        byte[] sig = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
        if (b.length < 33 || !startsWith(b, 0, sig) || !startsWith(b, 12, "IHDR".getBytes(StandardCharsets.US_ASCII))) return null;
        int ihdrLen = ByteBuffer.wrap(b, 8, 4).getInt();
        int ihdrEnd = 8 + 12 + ihdrLen;
        ByteArrayOutputStream add = new ByteArrayOutputStream();
        byte[] itxt = cat("XML:com.adobe.xmp".getBytes(StandardCharsets.US_ASCII), new byte[]{0, 0, 0, 0, 0}, utf8(xmp(m, Integer.MAX_VALUE)));
        byte[][] chunks = {
                pngChunk("iTXt", itxt), pngText("Title", title(m)),
                list(m, "artists").isEmpty() ? new byte[0] : pngText("Author", String.join(", ", list(m, "artists"))),
                pngText("Source", text(m, "url")),
                pngText("Description", text(m, "url") + " | md5:" + text(m, "md5")),
                pngText("Comment", limit(String.join(" ", list(m, "tags")), 30000)),
                pngText("Software", "Board Roamer"),
        };
        for (byte[] c : chunks) add.write(c, 0, c.length);
        byte[] a = add.toByteArray();
        return cat(Arrays.copyOfRange(b, 0, ihdrEnd), a, Arrays.copyOfRange(b, ihdrEnd, b.length));
    }

    private static String limit(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    /* ------------------------------------------------------------------ GIF */
    private static byte[] gif(byte[] b, JSONObject m) {
        if (b.length < 14 || !startsWith(b, 0, "GIF8".getBytes(StandardCharsets.US_ASCII))) return null;
        int flags = b[10] & 0xFF;
        int gct = (flags & 0x80) != 0 ? 3 * (2 << (flags & 7)) : 0;
        int pos = 13 + gct;
        if (b.length > pos + 19 && (b[pos] & 0xFF) == 0x21 && (b[pos + 1] & 0xFF) == 0xFF && b[pos + 2] == 0x0B
                && startsWith(b, pos + 3, "NETSCAPE2.0".getBytes(StandardCharsets.US_ASCII))) pos += 19; // keep the loop extension first
        if (pos > b.length) return null;
        ByteArrayOutputStream add = new ByteArrayOutputStream();
        String comment = title(m) + " | " + text(m, "url") + " | md5:" + text(m, "md5") + " | tags: " + String.join(" ", list(m, "tags"));
        byte[] cb = utf8(comment);
        add.write(0x21);
        add.write(0xFE);
        for (int o = 0; o < cb.length; o += 255) {
            int n = Math.min(255, cb.length - o);
            add.write(n);
            add.write(cb, o, n);
        }
        add.write(0);
        add.write(0x21);
        add.write(0xFF);
        add.write(0x0B);
        byte[] app = "XMP DataXMP".getBytes(StandardCharsets.US_ASCII);
        add.write(app, 0, app.length);
        byte[] x = utf8(xmp(m, Integer.MAX_VALUE));
        add.write(x, 0, x.length);
        add.write(0x01);
        for (int v = 0xFF; v >= 0; v--) add.write(v);
        add.write(0x00);
        byte[] a = add.toByteArray();
        return cat(Arrays.copyOfRange(b, 0, pos), a, Arrays.copyOfRange(b, pos, b.length));
    }

    /* ------------------------------------------------------------------ MP4 / MOV */
    private static boolean mp4Append(File f, JSONObject m) {
        try (RandomAccessFile r = new RandomAccessFile(f, "rw")) {
            byte[] head = new byte[12];
            r.readFully(head);
            if (!(head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p')) return false;
            byte[] x = utf8(xmp(m, Integer.MAX_VALUE));
            ByteBuffer bb = ByteBuffer.allocate(x.length + 24);
            bb.putInt(x.length + 24);
            bb.put(new byte[]{'u', 'u', 'i', 'd'});
            bb.put(new byte[]{(byte) 0xBE, 0x7A, (byte) 0xCF, (byte) 0xCB, (byte) 0x97, (byte) 0xA9, 0x42, (byte) 0xE8, (byte) 0x9C, 0x71, (byte) 0x99, (byte) 0x94, (byte) 0x91, (byte) 0xE3, (byte) 0xAF, (byte) 0xAC});
            bb.put(x);
            r.seek(r.length());
            r.write(bb.array());
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /* ------------------------------------------------------------------ WebM / Matroska */
    private static int vintWidth(int first) {
        return Integer.numberOfLeadingZeros(first & 0xFF) - 24 + 1;
    }

    private static byte[] vintFixed(long v, int w) {
        byte[] out = new byte[w];
        for (int i = 0; i < w; i++) out[w - 1 - i] = (byte) ((v >> (8 * i)) & 0xFF);
        out[0] |= (byte) (1 << (8 - w));
        return out;
    }

    private static byte[] ebmlSize(long len) {
        int w = 1;
        while (w < 8 && len >= (1L << (7 * w)) - 1) w++;
        return vintFixed(len, w);
    }

    private static byte[] elem(byte[] id, byte[] payload) {
        return cat(id, ebmlSize(payload.length), payload);
    }

    private static byte[] simpleTag(String name, String val) {
        byte[] p = cat(elem(new byte[]{0x45, (byte) 0xA3}, utf8(name)), elem(new byte[]{0x44, (byte) 0x87}, utf8(val)));
        return elem(new byte[]{0x67, (byte) 0xC8}, p);
    }

    private static byte[] mkvTags(JSONObject m) {
        String[][] pairs = {
                {"TITLE", title(m)}, {"ARTIST", String.join("; ", list(m, "artists"))}, {"KEYWORDS", String.join(" ", list(m, "tags"))},
                {"DESCRIPTION", text(m, "desc")}, {"PURL", text(m, "url")},
                {"COMMENT", text(m, "site") + " #" + text(m, "id") + " md5:" + text(m, "md5")},
                {"BOARDROAMER_SITE", text(m, "siteId")}, {"BOARDROAMER_ID", text(m, "id")}, {"MD5", text(m, "md5")},
                {"RATING", text(m, "rating")}, {"SOURCES", String.join(" ", list(m, "sources"))}, {"BOARDROAMER_JSON", m.toString()},
        };
        ByteArrayOutputStream tag = new ByteArrayOutputStream();
        byte[] targets = elem(new byte[]{0x63, (byte) 0xC0}, new byte[0]);
        tag.write(targets, 0, targets.length);
        for (String[] p : pairs) {
            if (p[1] == null || p[1].isEmpty()) continue;
            byte[] st = simpleTag(p[0], p[1]);
            tag.write(st, 0, st.length);
        }
        return elem(new byte[]{0x12, 0x54, (byte) 0xC3, 0x67}, elem(new byte[]{0x73, 0x73}, tag.toByteArray()));
    }

    private static boolean mkvPatch(File f, JSONObject m) {
        try (RandomAccessFile r = new RandomAccessFile(f, "rw")) {
            long len = r.length();
            byte[] head = new byte[16];
            r.readFully(head);
            if (!(head[0] == 0x1A && (head[1] & 0xFF) == 0x45 && (head[2] & 0xFF) == 0xDF && (head[3] & 0xFF) == 0xA3)) return false;
            int w1 = vintWidth(head[4] & 0xFF);
            if (w1 < 1 || w1 > 8) return false;
            long sz = (head[4] & 0xFF) & (0xFF >> w1);
            for (int i = 1; i < w1; i++) sz = (sz << 8) | (head[4 + i] & 0xFF);
            long segPos = 4 + w1 + sz;
            r.seek(segPos);
            byte[] seg = new byte[12];
            r.readFully(seg);
            if (!((seg[0] & 0xFF) == 0x18 && (seg[1] & 0xFF) == 0x53 && (seg[2] & 0xFF) == 0x80 && (seg[3] & 0xFF) == 0x67)) return false;
            int w = vintWidth(seg[4] & 0xFF);
            if (w < 1 || w > 8) return false;
            long size = (seg[4] & 0xFF) & (0xFF >> w);
            for (int i = 1; i < w; i++) size = (size << 8) | (seg[4 + i] & 0xFF);
            boolean unknown = size == (1L << (7 * w)) - 1;
            long dataStart = segPos + 4 + w;
            if (!unknown && dataStart + size != len) return false; // data after the segment
            byte[] tags = mkvTags(m);
            long newSize = size + tags.length;
            if (!unknown && newSize >= (1L << (7 * w)) - 1) return false;
            r.seek(len);
            r.write(tags);
            if (!unknown) {
                r.seek(segPos + 4);
                r.write(vintFixed(newSize, w));
            }
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /* ------------------------------------------------------------------ public API */
    static boolean isImage(String ext) {
        return ext.equals("jpg") || ext.equals("jpeg") || ext.equals("png") || ext.equals("gif");
    }

    /** Embed into an in-memory image. Null means unsupported or malformed: leave it alone. */
    static byte[] embedBytes(String ext, byte[] data, JSONObject m) {
        try {
            switch (ext) {
                case "jpg": case "jpeg": return jpeg(data, m);
                case "png": return png(data, m);
                case "gif": return gif(data, m);
                default: return null;
            }
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Patch a video that is already on disk. True when the metadata is inside the file. */
    static boolean embedFile(File f, String ext, JSONObject m) {
        switch (ext) {
            case "mp4": case "m4v": case "mov": return mp4Append(f, m);
            case "webm": case "mkv": return mkvPatch(f, m);
            default: return false;
        }
    }
}
