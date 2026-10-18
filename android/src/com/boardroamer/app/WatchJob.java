package com.boardroamer.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** The periodic wake-up that lets Watch look for new content while the app is closed. */
public final class WatchJob extends JobService {
    @Override public boolean onStartJob(JobParameters p) {
        new Thread(() -> {
            Watch.run(getApplicationContext());
            jobFinished(p, false);
        }, "br-watch").start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters p) { return true; } // retry later if the system cut us short
}
