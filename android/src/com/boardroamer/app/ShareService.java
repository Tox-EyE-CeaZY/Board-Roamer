package com.boardroamer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps this phone's folder sharing (Local) reachable while Board Roamer is closed. It only exists while sharing is on, it
 * shows one quiet ongoing notification with a "Stop sharing" button, and the notification never says what is shared.
 * The server itself lives in Local; this just stops Android from ending the process.
 */
public final class ShareService extends Service {
    static volatile boolean running = false;
    private static final String CHANNEL = "sharing", STOP = "com.boardroamer.app.STOP_SHARING";

    /** Start the service if sharing is on. Safe to call at any time; Android may refuse when the app is in the background. */
    static void start(Context c) {
        if (running) return;
        try {
            Intent i = new Intent(c, ShareService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Throwable ignored) { /* not allowed right now; it starts the next time the app opens */ }
    }

    static void stop(Context c) {
        try { c.stopService(new Intent(c, ShareService.class)); } catch (Throwable ignored) { }
    }

    @Override public void onCreate() {
        super.onCreate();
        Local.init(this);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Sharing folders", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while this phone shares its folders with your other devices");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int icon = getResources().getIdentifier("ic_mono", "drawable", getPackageName());
        if (icon == 0) icon = android.R.drawable.ic_dialog_info;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ShareService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL).setSmallIcon(icon).setContentTitle("Board Roamer").setContentText("Sharing with your devices")
            .setContentIntent(open).setOngoing(true).setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(null, "Stop sharing", stop).build()).build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(2, n);
            running = true;
        } catch (Throwable e) {
            stopSelf();
        }
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        if (i != null && STOP.equals(i.getAction())) {
            Local.stopSharing();
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }
}
