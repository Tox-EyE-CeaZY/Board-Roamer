package com.boardroamer.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Home screen widgets: Following, Library and Local, each in a few layouts (see WidgetProviders). The page hands over
 * a small summary whenever it changes (ui/js/widgets.js); the pictures are fetched and shrunk here, and every widget is
 * drawn from that summary with RemoteViews. Two looks: the app's own square, outlined one, and a fully rounded one
 * that follows One UI's corner radius (the default on Samsung phones). Per widget, adult sources show their pictures
 * only if you say so, and nothing shows pictures while "Blur thumbnails" is on.
 */
final class Widgets {
    private Widgets() {}

    enum Kind { FOLLOW, LIBRARY, LOCAL }
    enum Layout { STRIP, LIST, GRID, FEATURE, SUMMARY }

    static final String ACTION_OPEN = "com.boardroamer.app.OPEN_HASH";
    static final int STYLE_AUTO = 0, STYLE_CLASSIC = 1, STYLE_ROUND = 2;
    static final int PICS_SAFE = 0, PICS_ALL = 1, PICS_NONE = 2;

    private static final int TILE = 0xFF162226, INK = 0xFFF1F2DF, DIM = 0xFFA2BBB1;
    private static final Class<?>[] ALL = {
        WidgetProviders.FollowStrip.class, WidgetProviders.FollowList.class, WidgetProviders.FollowSummary.class,
        WidgetProviders.LibraryGrid.class, WidgetProviders.LibraryList.class, WidgetProviders.LibraryFeature.class,
        WidgetProviders.LocalGrid.class, WidgetProviders.LocalList.class, WidgetProviders.LocalRow.class };

    private static final Map<String, Integer> IDS = new HashMap<>();

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("widgets", Context.MODE_PRIVATE); }

    /** aapt2 builds here make no R class, so resources are looked up by name. */
    private static int rid(Context c, String type, String name) {
        String k = type + "/" + name;
        synchronized (IDS) {
            Integer v = IDS.get(k);
            if (v == null) { v = c.getResources().getIdentifier(name, type, c.getPackageName()); IDS.put(k, v); }
            return v;
        }
    }

    /* ------------------------------------------------------------------ settings per widget */
    static int style(Context c, int id) { return prefs(c).getInt("style_" + id, STYLE_AUTO); }
    static int pics(Context c, int id) { return prefs(c).getInt("pics_" + id, PICS_SAFE); }

    static void configure(Context c, int id, int style, int pics) {
        prefs(c).edit().putInt("style_" + id, style).putInt("pics_" + id, pics).apply();
    }

    static void forget(Context c, int[] ids) {
        SharedPreferences.Editor e = prefs(c).edit();
        for (int id : ids) e.remove("style_" + id).remove("pics_" + id);
        e.apply();
    }

    private static boolean round(Context c, int id) {
        int s = style(c, id);
        return s == STYLE_ROUND || (s == STYLE_AUTO && "samsung".equalsIgnoreCase(Build.MANUFACTURER));
    }

    /* ------------------------------------------------------------------ data from the page */
    /** The page sends a fresh summary whenever something changes. */
    static void update(Context c, String json) {
        final Context app = c.getApplicationContext();
        prefs(app).edit().putString("data", json).apply();
        refreshAll(app); // right away, with the pictures we already have
        new Thread(() -> {
            try {
                if (fetchPictures(app, new JSONObject(json))) refreshAll(app);
            } catch (Throwable ignored) { /* the widgets keep what they have */ }
        }, "br-widget-pics").start();
    }

    private static JSONObject data(Context c) {
        try { return new JSONObject(prefs(c).getString("data", "{}")); } catch (Throwable e) { return new JSONObject(); }
    }

    private static File picDir(Context c) {
        File d = new File(c.getFilesDir(), "widgets");
        d.mkdirs();
        return d;
    }

    private static File picFile(Context c, String url) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-1").digest(url.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 10; i++) sb.append(String.format(Locale.ROOT, "%02x", h[i]));
            return new File(picDir(c), sb + ".jpg");
        } catch (Exception e) { return new File(picDir(c), Integer.toHexString(url.hashCode()) + ".jpg"); }
    }

    /** Download and shrink the pictures the lists mention; forget the ones they no longer do. True if anything new arrived. */
    private static boolean fetchPictures(Context c, JSONObject d) {
        Set<String> want = new HashSet<>();
        boolean got = false;
        for (String key : new String[] { "follows", "library" }) {
            JSONArray a = d.optJSONArray(key);
            for (int i = 0; a != null && i < a.length(); i++) {
                String u = a.optJSONObject(i).optString("pic");
                if (u.isEmpty()) continue;
                File f = picFile(c, u);
                want.add(f.getName());
                if (f.exists()) continue;
                File tmp = new File(f.getPath() + ".tmp");
                try {
                    Net.download(u, null, tmp);
                    BitmapFactory.Options o = new BitmapFactory.Options();
                    o.inJustDecodeBounds = true;
                    BitmapFactory.decodeFile(tmp.getPath(), o);
                    int s = 1;
                    while (Math.max(o.outWidth, o.outHeight) / (s * 2) >= 360) s *= 2;
                    o.inJustDecodeBounds = false;
                    o.inSampleSize = s;
                    Bitmap b = BitmapFactory.decodeFile(tmp.getPath(), o);
                    if (b != null) {
                        try (FileOutputStream out = new FileOutputStream(f)) { b.compress(Bitmap.CompressFormat.JPEG, 85, out); }
                        b.recycle();
                        got = true;
                    }
                } catch (Throwable ignored) { /* no picture: the widget draws an initial instead */ }
                finally { tmp.delete(); }
            }
        }
        File[] old = picDir(c).listFiles();
        if (old != null) for (File f : old) if (!want.contains(f.getName())) f.delete();
        return got;
    }

    /* ------------------------------------------------------------------ refreshing */
    static void refreshAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (Class<?> k : ALL) {
            int[] ids = m.getAppWidgetIds(new ComponentName(c, k));
            if (ids.length == 0) continue;
            try {
                WidgetProviders.Base p = (WidgetProviders.Base) k.getDeclaredConstructor().newInstance();
                for (int id : ids) render(c, m, id, p.kind(), p.layout());
            } catch (Throwable e) { Log.w("BoardRoamer", "widget refresh failed", e); }
        }
    }

    static void refreshOne(Context c, int id) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        android.appwidget.AppWidgetProviderInfo info = m.getAppWidgetInfo(id);
        if (info == null) return;
        for (Class<?> k : ALL) {
            if (!k.getName().equals(info.provider.getClassName())) continue;
            try {
                WidgetProviders.Base p = (WidgetProviders.Base) k.getDeclaredConstructor().newInstance();
                render(c, m, id, p.kind(), p.layout());
            } catch (Throwable ignored) { /* shown again on the next refresh */ }
        }
    }

    /* ------------------------------------------------------------------ drawing */
    private static float dp(Context c, float v) { return v * c.getResources().getDisplayMetrics().density; }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    private static int color(JSONObject d, String key, int fallback) {
        try { return Color.parseColor(d.optString(key)); } catch (Throwable e) { return fallback; }
    }

    /** All the pictures of one widget travel to the launcher in a single binder call (about 1 MB at most), so they share this many pixels. */
    private static final int PX_BUDGET = 150_000;

    static void render(Context c, AppWidgetManager mgr, int id, Kind kind, Layout layout) {
        try {
            render(c, mgr, id, kind, layout, PX_BUDGET);
        } catch (RuntimeException e) { // too big for the launcher after all: again with far smaller pictures
            Log.w("BoardRoamer", "widget " + id + " retry smaller", e);
            try { render(c, mgr, id, kind, layout, PX_BUDGET / 6); } catch (RuntimeException e2) { Log.w("BoardRoamer", "widget " + id + " failed", e2); }
        }
    }

    private static void render(Context c, AppWidgetManager mgr, int id, Kind kind, Layout layout, int budget) {
        String pkg = c.getPackageName();
        JSONObject d = data(c);
        boolean round = round(c, id);
        int accent = color(d, "accent", 0xFFB1EF4A), ink = color(d, "accentInk", 0xFF0B1500);
        Bundle o = mgr.getAppWidgetOptions(id);
        int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250), h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110);
        if (w <= 0) w = 250;
        if (h <= 0) h = 110;
        int pad = round ? 12 : 8;
        boolean head = layout != Layout.SUMMARY && layout != Layout.FEATURE && h >= 100;
        float iw = w - 2 * pad, ih = h - 2 * pad - (head ? 30 : 0);

        RemoteViews rv = new RemoteViews(pkg, rid(c, "layout", "w_root"));
        rv.setInt(rid(c, "id", "root"), "setBackgroundResource", rid(c, "drawable", round ? "w_bg_round" : "w_bg_classic"));
        rv.setViewPadding(rid(c, "id", "inner"), (int) dp(c, pad), (int) dp(c, pad), (int) dp(c, pad), (int) dp(c, pad));
        String sectionHash = kind == Kind.FOLLOW ? "#/follows" : kind == Kind.LIBRARY ? "#/pools" : "#/local";
        int slot = 0;
        rv.setOnClickPendingIntent(rid(c, "id", "root"), open(c, id, slot++, sectionHash));

        // header
        rv.setViewVisibility(rid(c, "id", "head"), head ? 0 : 8);
        String title = kind == Kind.FOLLOW ? "FOLLOWING" : kind == Kind.LIBRARY ? "LIBRARY" : "LOCAL";
        rv.setTextViewText(rid(c, "id", "h_title"), title);
        rv.setImageViewResource(rid(c, "id", "h_icon"), rid(c, "drawable", kind == Kind.FOLLOW ? "ic_bell" : kind == Kind.LIBRARY ? "ic_book" : "ic_folder"));
        rv.setInt(rid(c, "id", "h_icon"), "setColorFilter", accent);
        int total = kind == Kind.FOLLOW ? d.optInt("followNew") : kind == Kind.LIBRARY ? d.optInt("libNew") : 0;
        pill(c, rv, "h_pill", total > 0 ? (total > 99 ? "99+" : total + " new") : null, accent, ink);

        rv.removeAllViews(rid(c, "id", "body"));
        int body = rid(c, "id", "body");
        JSONArray items = kind == Kind.FOLLOW ? d.optJSONArray("follows") : kind == Kind.LIBRARY ? d.optJSONArray("library") : d.optJSONArray("local");
        int n = items == null ? 0 : items.length();
        int pics = pics(c, id);
        int gCols = layout == Layout.GRID ? clamp((int) (iw / 80), 2, 5) : clamp((int) (iw / 70), 1, 6);
        int gRows = layout == Layout.GRID ? clamp((int) (ih / 92), 1, 4) : 1;
        int lRows = clamp((int) (ih / 50), 1, 6);
        int slots = layout == Layout.LIST ? lRows : layout == Layout.FEATURE ? 1 : gCols * gRows;
        int maxPx = budget / Math.max(1, Math.min(n, slots));
        boolean blur = d.optBoolean("blur");

        if (n == 0 && layout != Layout.SUMMARY) {
            RemoteViews e = new RemoteViews(pkg, rid(c, "layout", "w_empty"));
            e.setInt(rid(c, "id", "empty"), "setBackgroundColor", 0); // the widget's own background is already behind it
            e.setTextViewText(rid(c, "id", "e_msg"), kind == Kind.FOLLOW ? "Follow an artist in Board Roamer and their new posts show up here."
                : kind == Kind.LIBRARY ? "Save a pool or comic to your library and its new pages show up here."
                : d.has("v") ? "Turn on Local in Settings and choose folders to open them from here." : "Open Board Roamer to load this widget.");
            rv.addView(body, e);
            mgr.updateAppWidget(id, rv);
            return;
        }

        switch (layout) {
            case SUMMARY: {
                RemoteViews s = new RemoteViews(pkg, rid(c, "layout", "w_summary"));
                int fresh = d.optInt("followNew");
                s.setTextViewText(rid(c, "id", "s_num"), fresh > 99 ? "99+" : String.valueOf(fresh));
                s.setTextColor(rid(c, "id", "s_num"), fresh > 0 ? accent : DIM);
                s.setTextViewText(rid(c, "id", "s_label"), fresh == 0 ? "ALL CAUGHT UP" : fresh == 1 ? "NEW POST" : "NEW POSTS");
                StringBuilder names = new StringBuilder();
                int shown = 0;
                for (int i = 0; i < n && shown < 3; i++) {
                    JSONObject it = items.optJSONObject(i);
                    if (it.optInt("new") <= 0) break;
                    if (shown > 0) names.append(", ");
                    names.append(it.optString("n"));
                    shown++;
                }
                s.setTextViewText(rid(c, "id", "s_names"), shown > 0 ? names.toString() : d.optInt("followTotal") + " followed");
                s.setViewVisibility(rid(c, "id", "s_names"), h >= 70 ? 0 : 8);
                rv.addView(body, s);
                break;
            }
            case FEATURE: {
                JSONObject it = items.optJSONObject(0);
                for (int i = 0; i < n; i++) if (items.optJSONObject(i).optInt("new") > 0) { it = items.optJSONObject(i); break; }
                RemoteViews f = new RemoteViews(pkg, rid(c, "layout", "w_feature"));
                int nw = it.optInt("new");
                f.setImageViewBitmap(rid(c, "id", "f_img"), picture(c, it, round, showPic(it, pics, blur), (int) iw, (int) (h - 2 * pad), accent, maxPx));
                f.setTextViewText(rid(c, "id", "f_kicker"), nw > 0 ? "NEW PAGES" : "IN YOUR LIBRARY");
                f.setTextColor(rid(c, "id", "f_kicker"), accent);
                f.setTextViewText(rid(c, "id", "f_title"), it.optString("n"));
                f.setTextViewText(rid(c, "id", "f_sub"), nw > 0 ? nw + " new · " + it.optInt("count") + " pages" : it.optInt("count") + " pages");
                f.setOnClickPendingIntent(rid(c, "id", "feat"), open(c, id, slot++, it.optString("hash", "#/pools")));
                rv.addView(body, f);
                break;
            }
            case LIST: {
                int rows = lRows;
                for (int i = 0; i < Math.min(n, rows); i++) {
                    JSONObject it = items.optJSONObject(i);
                    RemoteViews l = new RemoteViews(pkg, rid(c, "layout", "w_line"));
                    l.setInt(rid(c, "id", "line"), "setBackgroundResource", rid(c, "drawable", round ? "w_tile_round" : "w_tile_classic"));
                    if (kind == Kind.LOCAL) {
                        l.setImageViewResource(rid(c, "id", "l_img"), rid(c, "drawable", "ic_folder"));
                        l.setInt(rid(c, "id", "l_img"), "setColorFilter", accent);
                        l.setTextViewText(rid(c, "id", "l_t2"), it.optString("sub"));
                        pill(c, l, "l_pill", null, accent, ink);
                    } else {
                        l.setImageViewBitmap(rid(c, "id", "l_img"), picture(c, it, round, showPic(it, pics, blur), 44, 44, accent, maxPx));
                        int nw = it.optInt("new");
                        l.setTextViewText(rid(c, "id", "l_t2"), kind == Kind.FOLLOW ? (nw > 0 ? nw + " new" : "Up to date") + (it.optString("site").isEmpty() ? "" : " · " + it.optString("site"))
                            : (nw > 0 ? nw + " new pages" : it.optInt("count") + " pages"));
                        pill(c, l, "l_pill", nw > 0 ? (nw > 99 ? "99+" : String.valueOf(nw)) : null, accent, ink);
                    }
                    l.setTextViewText(rid(c, "id", "l_t1"), it.optString("n"));
                    l.setOnClickPendingIntent(rid(c, "id", "line"), open(c, id, slot++, it.optString("hash", sectionHash)));
                    rv.addView(body, l);
                }
                break;
            }
            default: { // STRIP and GRID: tiles (pictures) or chips (folders), side by side
                boolean grid = layout == Layout.GRID;
                int cols = gCols, rows = gRows;
                float tw = iw / cols - 6, th = ih / rows - 6;
                int at = 0;
                for (int r = 0; r < rows && at < n; r++) {
                    RemoteViews row = new RemoteViews(pkg, rid(c, "layout", "w_row"));
                    for (int k = 0; k < cols; k++) {
                        if (at >= n) { row.addView(rid(c, "id", "row"), new RemoteViews(pkg, rid(c, "layout", "w_spacer"))); continue; }
                        JSONObject it = items.optJSONObject(at++);
                        RemoteViews t;
                        if (kind == Kind.LOCAL) {
                            t = new RemoteViews(pkg, rid(c, "layout", "w_chip"));
                            t.setInt(rid(c, "id", "chip"), "setBackgroundResource", rid(c, "drawable", round ? "w_tile_round" : "w_tile_classic"));
                            t.setInt(rid(c, "id", "c_icon"), "setColorFilter", accent);
                            t.setTextViewText(rid(c, "id", "c_name"), it.optString("n"));
                            t.setTextViewText(rid(c, "id", "c_sub"), it.optString("sub"));
                            t.setViewVisibility(rid(c, "id", "c_sub"), th >= 64 ? 0 : 8);
                            t.setOnClickPendingIntent(rid(c, "id", "chip"), open(c, id, slot++, it.optString("hash", sectionHash)));
                        } else {
                            t = new RemoteViews(pkg, rid(c, "layout", "w_tile"));
                            t.setImageViewBitmap(rid(c, "id", "t_img"), picture(c, it, round, showPic(it, pics, blur), (int) tw, (int) th, accent, maxPx));
                            int nw = it.optInt("new");
                            pill(c, t, "t_pill", nw > 0 ? (nw > 99 ? "99+" : String.valueOf(nw)) : null, accent, ink);
                            t.setTextViewText(rid(c, "id", "t_label"), it.optString("n"));
                            t.setViewVisibility(rid(c, "id", "t_label"), th >= 52 ? 0 : 8);
                            t.setOnClickPendingIntent(rid(c, "id", "tile"), open(c, id, slot++, it.optString("hash", sectionHash)));
                        }
                        row.addView(rid(c, "id", "row"), t);
                    }
                    rv.addView(body, row);
                }
            }
        }
        mgr.updateAppWidget(id, rv);
    }

    private static boolean showPic(JSONObject it, int pics, boolean blur) {
        return !blur && (pics == PICS_ALL || (pics == PICS_SAFE && !it.optBoolean("adult")));
    }

    /** A rounded count badge: text on a pill tinted with the accent. Null text hides it. */
    private static void pill(Context c, RemoteViews rv, String name, String text, int accent, int ink) {
        if (text == null) { rv.setViewVisibility(rid(c, "id", name), 8); return; }
        rv.setViewVisibility(rid(c, "id", name), 0);
        rv.setInt(rid(c, "id", name + "_bg"), "setColorFilter", accent);
        rv.setTextViewText(rid(c, "id", name + "_txt"), text);
        rv.setTextColor(rid(c, "id", name + "_txt"), ink);
    }

    private static PendingIntent open(Context c, int widget, int slot, String hash) {
        Intent i = new Intent(c, MainActivity.class).setAction(ACTION_OPEN).putExtra("hash", hash)
            .setData(Uri.parse("boardroamer://widget/" + widget + "/" + slot)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * The tile's picture, cropped to the shape it will be shown in and with rounded corners (none in the classic look).
     * Without a picture (not downloaded yet, hidden, or none) it is the item's initial on a dark tile.
     */
    private static Bitmap picture(Context c, JSONObject it, boolean round, boolean show, int wDp, int hDp, int accent, int maxPx) {
        float dens = c.getResources().getDisplayMetrics().density;
        float scale = Math.min(Math.min(1f, 320f / Math.max(1f, Math.max(wDp, hDp) * dens)), (float) Math.sqrt(maxPx / Math.max(1f, wDp * dens * hDp * dens)));
        int w = Math.max(24, (int) (wDp * dens * scale)), h = Math.max(24, (int) (hDp * dens * scale));
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        float rad = round ? Math.min(w, h) * 0.16f : 0f;
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        RectF box = new RectF(0, 0, w, h);
        Bitmap src = null;
        String url = it.optString("pic");
        if (show && !url.isEmpty()) {
            File f = picFile(c, url);
            if (f.exists()) src = BitmapFactory.decodeFile(f.getPath());
        }
        if (src != null) {
            float k = Math.max((float) w / src.getWidth(), (float) h / src.getHeight());
            android.graphics.Matrix m = new android.graphics.Matrix();
            m.setScale(k, k);
            m.postTranslate((w - src.getWidth() * k) / 2f, (h - src.getHeight() * k) / 2f);
            BitmapShader sh = new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
            sh.setLocalMatrix(m);
            p.setShader(sh);
            cv.drawRoundRect(box, rad, rad, p);
            src.recycle();
        } else {
            p.setColor(TILE);
            cv.drawRoundRect(box, rad, rad, p);
            String name = it.optString("n").trim();
            if (!name.isEmpty()) {
                Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
                t.setColor(accent);
                t.setAlpha(190);
                t.setTextAlign(Paint.Align.CENTER);
                t.setFakeBoldText(true);
                t.setTextSize(Math.min(w, h) * 0.46f);
                cv.drawText(name.substring(0, name.offsetByCodePoints(0, 1)).toUpperCase(Locale.ROOT), w / 2f, h / 2f - (t.ascent() + t.descent()) / 2f, t);
            }
        }
        return out;
    }
}
