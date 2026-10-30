package com.omranisystems.remoteagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;

/**
 * After the phone restarts (or the app is updated) while sharing was on: Android 10 and older let the service
 * restart the camera directly; Android 11+ forbid the camera until the user opens the app, so we post a
 * "Tap to resume" notification instead (MainActivity resumes sharing when opened).
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (!ctx.getSharedPreferences(AgentService.PREFS, Context.MODE_PRIVATE).getBoolean("sharing", false)) return;
        if (AgentService.active) return;
        boolean updated = Intent.ACTION_MY_PACKAGE_REPLACED.equals(a);
        if (Build.VERSION.SDK_INT < 30) {
            try {
                ContextCompat.startForegroundService(ctx, new Intent(ctx, AgentService.class));
                return;
            } catch (Exception ignored) { /* fall back to asking */ }
        }
        AgentService.notifyResume(ctx, updated ? "Remote was updated" : "Phone restarted",
            "Sharing was on. Tap to resume the camera.");
    }
}
