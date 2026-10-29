package com.omranisystems.remoteagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Runs while this device is shared: Android keeps the camera and microphone, the CPU and the Wi-Fi awake when the
 * screen is off or the app is in the background. Shows an ongoing "sharing" notification that opens the app.
 * Must be started while the app is in the foreground (Android 11+ rule for camera services).
 */
public class AgentService extends Service {
    static final String CHANNEL = "ra_sharing";
    static final int ID = 5501;

    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String name = intent == null ? null : intent.getStringExtra("name");
        boolean audio = intent != null && intent.getBooleanExtra("audio", false);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Device shared", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while this device is connected to Remote");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setColor(0xFF2FD1D9)
            .setContentTitle("Remote · device shared")
            .setContentText(name == null || name.isEmpty() ? "Camera available to your dashboard" : name + " · camera available to your dashboard")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(tap)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            if (audio) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            try {
                startForeground(ID, n, type);
            } catch (Exception e) {
                // e.g. the microphone permission was not granted: keep at least the camera
                startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
            }
        } else {
            startForeground(ID, n);
        }
        holdLocks();
        return START_NOT_STICKY;
    }

    private void holdLocks() {
        if (cpu == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "remoteagent:sharing");
            cpu.setReferenceCounted(false);
        }
        if (!cpu.isHeld()) cpu.acquire();
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifi = wm.createWifiLock(mode, "remoteagent:sharing");
            wifi.setReferenceCounted(false);
        }
        if (!wifi.isHeld()) wifi.acquire();
    }

    @Override
    public void onDestroy() {
        if (cpu != null && cpu.isHeld()) cpu.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away: the page (and its stream) is gone
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
