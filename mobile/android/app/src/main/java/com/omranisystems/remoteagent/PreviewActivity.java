package com.omranisystems.remoteagent;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;

/**
 * "Check camera": full-screen live view of the exact track the dashboard receives, on the phone itself.
 * Opened from the app's sharing screen; only while sharing (it renders the running NativeAgent's camera).
 * Closing it releases the camera again when nobody is watching.
 */
public class PreviewActivity extends Activity {
    private SurfaceViewRenderer renderer;
    private NativeAgent agent;
    private boolean attached;
    private volatile boolean closed;

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        agent = NativeAgent.current;
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

        TextView label = new TextView(this);
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

        Button close = new Button(this);
        close.setText("Close");
        close.setAllCaps(false);
        close.setTextColor(Color.parseColor("#050B14"));
        GradientDrawable btn = new GradientDrawable();
        btn.setColor(Color.parseColor("#2FD1D9"));
        btn.setCornerRadius(dp(12));
        close.setBackground(btn);
        close.setOnClickListener(v -> finish());
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(dp(180), dp(50), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        bp.bottomMargin = dp(48);
        root.addView(close, bp);

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
            renderer.setMirror(agent.isFront()); // front camera: show it like a mirror, as people expect
            agent.attachPreview(renderer);
            attached = true;
        }));
    }

    @Override
    protected void onDestroy() {
        closed = true;
        if (agent != null && renderer != null) {
            SurfaceViewRenderer r = renderer;
            boolean init = attached;
            agent.closePreview(r, () -> runOnUiThread(() -> { if (init) r.release(); }));
        }
        super.onDestroy();
    }
}
