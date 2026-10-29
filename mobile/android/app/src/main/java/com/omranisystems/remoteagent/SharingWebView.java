package com.omranisystems.remoteagent;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's WebView, except that while this device is shared it keeps telling Chromium its window is visible.
 * When another app comes to the front Android hides our window, the page turns "hidden" and Chromium stops the
 * camera capture — the stream would die. (A locked screen keeps the window visible, which is why that case
 * already worked.) Outside sharing it behaves normally, so the dashboard still pauses in the background.
 */
public class SharingWebView extends CapacitorWebView {
    static volatile boolean keepVisible = false;

    public SharingWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(keepVisible ? View.VISIBLE : visibility);
    }

    /** Re-applies the real window visibility after sharing stops (we may have been hiding a GONE window). */
    void refreshVisibility() {
        super.onWindowVisibilityChanged(keepVisible ? View.VISIBLE : getWindowVisibility());
    }
}
