package com.omranisystems.remoteagent;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;

/**
 * "Check camera": full-screen live view of the exact track the dashboard receives, on the phone itself, with
 * Switch camera and Record buttons. Opened from the app's sharing screen, only while sharing.
 *
 * The renderer uses NativeAgent's process-wide EGL context and is registered as a process-wide preview, so it
 * survives the agent restarting underneath it (it is re-attached to the new camera track). Closing releases the
 * camera again when nobody is watching.
 */
public class PreviewActivity extends Activity {
    private SurfaceViewRenderer renderer;
    private boolean attached;
    private volatile boolean closed;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Boolean mirrored;
    private TextView label;
    private Button rec;
    private Boolean recShown;

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private Button pillButton(String text, boolean primary) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(Color.parseColor(primary ? "#050B14" : "#EAF0F6"));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(primary ? "#2FD1D9" : "#B3050B14"));
        bg.setCornerRadius(dp(12));
        if (!primary) bg.setStroke(dp(1), Color.parseColor("#4D8BA8C4"));
        b.setBackground(bg);
        return b;
    }

    private void styleRecord(boolean recording) {
        rec.setText(recording ? "Stop rec" : "Record");
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(recording ? "#E5484D" : "#B3050B14"));
        bg.setCornerRadius(dp(12));
        bg.setStroke(dp(1), Color.parseColor(recording ? "#E5484D" : "#4D8BA8C4"));
        rec.setBackground(bg);
        rec.setTextColor(Color.WHITE);
    }

    // keeps the mirror in step with the camera side (front = mirror), e.g. after Switch camera, and shows the
    // recording state (started here, in the app or stopped from the notification)
    private final Runnable syncMirror = new Runnable() {
        @Override public void run() {
            if (closed) return;
            boolean m = NativeAgent.frontNow;
            if (attached && (mirrored == null || mirrored != m)) { renderer.setMirror(m); mirrored = m; }
            Recorder r = NativeAgent.RECORDER;
            if (recShown == null || recShown != (r != null)) { recShown = r != null; styleRecord(recShown); }
            if (r != null) {
                long s = (System.currentTimeMillis() - r.since) / 1000;
                label.setText(String.format(java.util.Locale.US, "●  REC %02d:%02d · saving to this phone", s / 60, s % 60));
                label.setTextColor(Color.parseColor("#FF6B70"));
            } else {
                label.setText("●  Camera check · what the dashboard sees");
                label.setTextColor(Color.parseColor("#EAF0F6"));
            }
            ui.postDelayed(this, 300);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        NativeAgent agent = NativeAgent.current;
        if (agent == null) {
            Toast.makeText(this, "Start sharing first", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#050B14"));
        renderer = new SurfaceViewRenderer(this);
        root.addView(renderer, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        label = new TextView(this);
        label.setText("●  Camera check · what the dashboard sees");
        label.setTextColor(Color.parseColor("#EAF0F6"));
        label.setTypeface(Typeface.MONOSPACE);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        label.setPadding(dp(14), dp(8), dp(14), dp(8));
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(Color.parseColor("#B3050B14"));
        pill.setCornerRadius(dp(20));
        label.setBackground(pill);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.topMargin = dp(44);
        root.addView(label, lp);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        Button flip = pillButton("Switch", false);
        Button close = pillButton("Close", true);
        rec = pillButton("Record", false);
        rec.setOnClickListener(v -> {
            rec.setEnabled(false);
            ui.postDelayed(() -> rec.setEnabled(true), 1200);
            if (NativeAgent.RECORDER != null) { NativeAgent.stopRecording(null); return; }
            AgentService.startRecording(err -> {
                if (err != null) runOnUiThread(() -> Toast.makeText(this, err, Toast.LENGTH_LONG).show());
            });
        });
        flip.setOnClickListener(v -> {
            AgentService.switchCamera(this, !NativeAgent.frontNow);
            flip.setEnabled(false); // debounce: a switch takes a moment
            ui.postDelayed(() -> flip.setEnabled(true), 1200);
        });
        close.setOnClickListener(v -> finish());
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(dp(104), dp(50));
        blp.setMargins(dp(5), 0, dp(5), 0);
        bar.addView(flip, blp);
        bar.addView(rec, new LinearLayout.LayoutParams(blp));
        bar.addView(close, new LinearLayout.LayoutParams(blp));
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        bp.bottomMargin = dp(48);
        root.addView(bar, bp);

        setContentView(root);

        agent.openPreview(egl -> runOnUiThread(() -> {
            if (closed) return;
            if (egl == null) {
                Toast.makeText(this, NativeAgent.lastError.isEmpty() ? "Camera unavailable" : NativeAgent.lastError, Toast.LENGTH_LONG).show();
                finish();
                return;
            }
            renderer.init(egl, null);
            renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
            NativeAgent.attachPreview(renderer);
            attached = true;
            ui.post(syncMirror);
        }));
    }

    @Override
    protected void onDestroy() {
        closed = true;
        ui.removeCallbacksAndMessages(null);
        if (renderer != null) {
            SurfaceViewRenderer r = renderer;
            boolean init = attached;
            NativeAgent.closePreview(r, () -> runOnUiThread(() -> { if (init) r.release(); }));
        }
        super.onDestroy();
    }
}
