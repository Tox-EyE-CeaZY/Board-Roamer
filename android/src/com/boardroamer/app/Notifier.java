package com.boardroamer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * The one place that posts a notification. Text only: no picture, no preview of content. On the lock screen it shows a
 * bare "Board Roamer / New activity" instead of the text, so nothing can be read without unlocking.
 */
final class Notifier {
    private Notifier() {}

    private static final String CHANNEL = "updates_banner"; // importance cannot be raised once a channel exists, so the old "updates" channel was retired

    static boolean allowed(Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    static void post(Context c, String title, String body) {
        if (!allowed(c)) return;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            nm.deleteNotificationChannel("updates");
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "New content", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Follows, boards and pools that have something new");
                ch.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
                nm.createNotificationChannel(ch);
            }
            int icon = c.getResources().getIdentifier("ic_mono", "drawable", c.getPackageName());
            if (icon == 0) icon = android.R.drawable.ic_dialog_info;
            Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification pub = new Notification.Builder(c, CHANNEL).setSmallIcon(icon).setContentTitle("Board Roamer").setContentText("New activity").build();
            Notification n = new Notification.Builder(c, CHANNEL).setSmallIcon(icon).setContentTitle(title).setContentText(body)
                .setContentIntent(pi).setAutoCancel(true).setCategory(Notification.CATEGORY_RECOMMENDATION).setDefaults(Notification.DEFAULT_ALL).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(pub).build();
            nm.notify(1, n); // one slot: a newer notice replaces the last instead of piling up
        } catch (Throwable ignored) { /* notifications are a nicety */ }
    }
}
