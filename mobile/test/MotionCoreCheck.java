package com.omranisystems.remoteagent;

/** Checks MotionCore on synthetic scenes (no Android, no camera). Exit 1 on failure. */
public class MotionCoreCheck {
    static int failures = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) failures++; }

    static int[] scene(int base, java.util.Random noise) {
        int[] g = new int[MotionCore.W * MotionCore.H];
        for (int i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, base + (i % 7) * 3 + noise.nextInt(9) - 4));
        return g;
    }
    /** A bright "person" rectangle w×h at (x, y). */
    static int[] withBlock(int[] g, int x, int y, int w, int h) {
        int[] out = g.clone();
        for (int r = y; r < y + h; r++) for (int c = x; c < x + w; c++) out[r * MotionCore.W + c] = 240;
        return out;
    }

    public static void main(String[] a) {
        java.util.Random rnd = new java.util.Random(7);
        long t = 0;

        MotionCore m = new MotionCore("medium", 120_000);
        int alerts = 0;
        for (int i = 0; i < 40; i++) if (m.feed(scene(90, rnd), t += 500)) alerts++;
        check(alerts == 0, "a still scene with sensor noise gives no alert");

        for (int i = 0; i < 60; i++) if (m.feed(scene(90 + i, rnd), t += 500)) alerts++; // dusk/dawn: slow light change
        check(alerts == 0, "a slow light change (60 brightness steps over 30 s) gives no alert");

        int[] base = scene(150, rnd);
        check(!m.feed(withBlock(base, 10, 5, 3, 3), t += 500), "one changed sample is not enough (glitch)");
        boolean first = false;
        for (int i = 0; i < 4 && !first; i++) first = m.feed(withBlock(scene(150, rnd), 20 + i * 2, 8, 10, 20), t += 500);
        check(first, "a person-sized moving shape is reported");
        boolean again = false;
        for (int i = 0; i < 20; i++) again |= m.feed(withBlock(scene(150, rnd), 30 - i, 8, 10, 20), t += 500);
        check(!again, "no second alert during the 2-minute cool-down");
        t += 120_000;
        boolean after = false;
        for (int i = 0; i < 6 && !after; i++) after = m.feed(withBlock(scene(150, rnd), 5 + i * 3, 8, 10, 20), t += 500);
        check(after, "alerts again after the cool-down");

        // sensitivity: a small shape (a cat far away, ~2% of the picture)
        int small = 0, smallLow = 0;
        MotionCore hi = new MotionCore("high", 0), lo = new MotionCore("low", 0);
        for (int i = 0; i < 10; i++) { hi.feed(scene(120, rnd), t += 500); lo.feed(scene(120, rnd), t); }
        for (int i = 0; i < 8; i++) {
            int[] g = withBlock(scene(120, rnd), 10 + i * 4, 20, 7, 7);
            if (hi.feed(g, t += 500)) small++;
            if (lo.feed(g, t)) smallLow++;
        }
        check(small > 0, "high sensitivity notices a small shape");
        check(smallLow == 0, "low sensitivity ignores it");
        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
