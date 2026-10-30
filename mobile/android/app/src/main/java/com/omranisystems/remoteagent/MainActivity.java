package com.omranisystems.remoteagent;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AgentPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Sharing that the user never stopped but that isn't running (phone restarted, app updated, Android killed it)
     * resumes as soon as the app is on screen — the only moment Android lets us open the camera again.
     */
    @Override
    public void onResume() {
        super.onResume();
        SharedPreferences prefs = getSharedPreferences(AgentService.PREFS, MODE_PRIVATE);
        if (AgentService.active || !prefs.getBoolean("sharing", false) || prefs.getString("token", "").isEmpty()) return;
        try {
            ContextCompat.startForegroundService(this, new Intent(this, AgentService.class)); // no action: settings from prefs
            AgentService.clearResumeNotice(this);
        } catch (Exception e) {
            Log.w("RemoteAgent", "resume", e);
        }
    }
}
