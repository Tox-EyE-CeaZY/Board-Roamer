package com.boardroamer.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart: bring folder sharing back if it was on, and re-announce this phone to the desktop. */
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (i == null || !Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        Local.init(c); // starts the server and the service if sharing was on
    }
}
