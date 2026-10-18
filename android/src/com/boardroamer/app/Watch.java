package com.boardroamer.app;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Looks for new content while the app is closed, with no push service involved. The page hands over a watch list
 * (the exact request for each followed artist, live board and saved pool, plus how much you have already seen) and a
 * periodic job asks the sites the same question the page would. It stays quiet while the app is on screen, since the
 * page shows badges itself, and it only ever posts generic text (see Notifier).
 */
final class Watch {
    private Watch() {}

    private static final int JOB = 42;
    private static final long EVERY_MS = 30 * 60 * 1000L;
    /** Set by MainActivity: true while the app is in front of the user. */
    static volatile boolean visible = false;

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("watch", Context.MODE_PRIVATE); }

    /** The page sends a fresh watch list whenever something changes. */
    static void update(Context c, String json) {
        prefs(c).edit().putString("list", json).apply();
        boolean on = false;
        try { on = new JSONObject(json).optBoolean("notify"); } catch (Throwable ignored) { }
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        if (!on) { js.cancel(JOB); return; }
        JobInfo pending = js.getPendingJob(JOB);
        if (pending != null && pending.getIntervalMillis() == EVERY_MS) return; // already ticking: leave its schedule alone
        js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, WatchJob.class))
            .setPeriodic(EVERY_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build());
    }

    private static String names(List<String> n) {
        if (n.size() <= 2) return String.join(" and ", n);
        return n.get(0) + ", " + n.get(1) + " and " + (n.size() - 2) + " more";
    }

    /** One pass over the watch list. Runs on the job's own thread. */
    static void run(Context c) {
        try {
            if (visible) return;
            SharedPreferences sp = prefs(c);
            String raw = sp.getString("list", null);
            if (raw == null) return;
            JSONObject w = new JSONObject(raw);
            if (!w.optBoolean("notify") || !Notifier.allowed(c)) return;
            JSONObject done = new JSONObject(sp.getString("done", "{}"));
            JSONObject next = new JSONObject();
            JSONArray items = w.optJSONArray("items");
            List<String> who = new ArrayList<>();
            boolean follows = false, boards = false, pools = false;
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String key = it.getString("key"), kind = it.getString("kind");
                long seen = it.optLong("seen", 0);
                long latest = latest(it, w.optString("ua"));
                long before = done.optLong(key, 0);
                if (latest < 0) { if (before > 0) next.put(key, before); continue; } // a failed check changes nothing
                next.put(key, latest);
                if (seen <= 0 && !"pool".equals(kind)) continue; // never baselined by the page yet
                if (latest > Math.max(seen, before)) {
                    if ("follow".equals(kind)) { follows = true; who.add(it.optString("name")); }
                    else if ("board".equals(kind)) boards = true;
                    else pools = true;
                }
            }
            sp.edit().putString("done", next.toString()).apply();
            if (visible) return; // the app came to the front while we were checking
            List<String> kinds = new ArrayList<>();
            if (follows) kinds.add("follows");
            if (boards) kinds.add("boards");
            if (pools) kinds.add("pools");
            if (kinds.isEmpty()) return;
            String body;
            if (kinds.size() == 1) {
                if (follows) body = w.optBoolean("names") && !who.isEmpty() ? "New posts from " + names(who) : "New posts from your follows";
                else body = boards ? "Your boards have new updates" : "New pages in your pools";
            } else {
                body = "New activity in your " + String.join(", ", kinds.subList(0, kinds.size() - 1)) + " and " + kinds.get(kinds.size() - 1);
            }
            Notifier.post(c, "Board Roamer", body);
        } catch (Throwable ignored) { /* try again next time */ }
    }

    /** The newest post id (or, for a pool, its page count) the site reports. -1 if the check failed. */
    private static long latest(JSONObject it, String ua) {
        Net.Resp r = Net.api("GET", it.optString("url"), ua, it.optString("auth"), null);
        if (r.code != 200) return -1;
        try {
            Object j = new JSONTokener(new String(r.body, StandardCharsets.UTF_8)).nextValue();
            String eng = it.optString("eng");
            if ("pool".equals(eng)) return j instanceof JSONObject ? ((JSONObject) j).optLong("post_count", -1) : -1;
            JSONArray list = null;
            if (j instanceof JSONArray) list = (JSONArray) j;
            else if (j instanceof JSONObject) {
                JSONObject o = (JSONObject) j;
                Object p = "gb".equals(eng) ? o.opt("post") : "pm".equals(eng) ? o.opt("images") : o.opt("posts");
                if (p instanceof JSONArray) list = (JSONArray) p;
                else if (p instanceof JSONObject) list = new JSONArray().put(p);
                else if (p == null) return 0; // an empty search
            }
            if (list == null) return -1;
            long max = 0;
            for (int i = 0; i < list.length(); i++) max = Math.max(max, list.getJSONObject(i).optLong("id", 0));
            return max;
        } catch (Throwable e) {
            return -1;
        }
    }
}
