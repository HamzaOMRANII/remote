package com.omranisystems.remoteagent;

/**
 * Motion detection on small brightness grids (M8c). Plain Java, no Android classes: tested on the JVM
 * (mobile/test/MotionCoreCheck.java). MotionDetector feeds it a 64×36 luma grid twice a second.
 *
 * It keeps a slowly adapting background (so dusk, clouds or auto-exposure don't count), counts the cells that
 * differ from it by more than PIXEL_DIFF, and reports motion when that share is above the sensitivity level in
 * two samples in a row (one glitchy frame is ignored). After a report it stays quiet for `cooldownMs`.
 */
final class MotionCore {
    static final int W = 64, H = 36;
    private static final int PIXEL_DIFF = 28;      // out of 255: a real change, not sensor noise
    private static final float LEARN = 0.08f;      // background follows slow changes (about 6 s at 2 samples/s)

    /** Share of the picture that must change: low sensitivity = a big change (a person close by). */
    static float threshold(String level) {
        if ("high".equals(level)) return 0.015f;
        if ("low".equals(level)) return 0.08f;
        return 0.035f; // medium
    }

    private final float threshold;
    private final long cooldownMs;
    private float[] background;
    private int warmup = 4;          // the first samples only build the background
    private int streak;
    private long lastAlertAt = -1;
    float lastChange;                // for tests / diagnostics

    MotionCore(String level, long cooldownMs) {
        this.threshold = threshold(level);
        this.cooldownMs = cooldownMs;
    }

    /** One grid (W*H luma values 0-255) at time `now`. True when motion should be reported now. */
    boolean feed(int[] luma, long now) {
        if (luma.length != W * H) throw new IllegalArgumentException("grid must be " + W + "x" + H);
        if (background == null) {
            background = new float[luma.length];
            for (int i = 0; i < luma.length; i++) background[i] = luma[i];
            return false;
        }
        int changed = 0;
        for (int i = 0; i < luma.length; i++) {
            if (Math.abs(luma[i] - background[i]) > PIXEL_DIFF) changed++;
            background[i] += (luma[i] - background[i]) * LEARN;
        }
        lastChange = changed / (float) luma.length;
        if (warmup > 0) { warmup--; return false; }
        streak = lastChange >= threshold ? streak + 1 : 0;
        if (streak < 2) return false;
        if (lastAlertAt >= 0 && now - lastAlertAt < cooldownMs) return false;
        lastAlertAt = now;
        streak = 0;
        return true;
    }
}
