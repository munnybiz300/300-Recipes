package com.personal.threehundredrecipes;

/**
 * Renders one play of the alarm tune as 16-bit mono PCM: a soft sine "pluck", the same sound
 * the in-app (Web Audio) version makes. Pure Java, no Android classes, so it can be tested anywhere.
 */
final class TuneSynth {
    static final int RATE = 22050;
    private static final double SLOT = 0.3125;
    private static final double LOW = 0.0001 / 0.35;   // "silence" level, relative to the peak
    private static final double SUSTAIN = 0.14 / 0.35; // level a held note settles at

    private TuneSynth() {}

    /** freq[i] Hz, start[i] and dur[i] in seconds. The result is exactly `seconds` long. */
    static short[] render(double[] freq, double[] start, double[] dur, double seconds, double peak) {
        int total = (int) Math.round(seconds * RATE);
        float[] mix = new float[total];
        for (int n = 0; n < freq.length; n++) addNote(mix, freq[n], start[n], dur[n], peak);
        short[] out = new short[total];
        for (int i = 0; i < total; i++) {
            double v = Math.max(-1.0, Math.min(1.0, mix[i]));
            out[i] = (short) Math.round(v * 32767.0);
        }
        return out;
    }

    private static void addNote(float[] mix, double freq, double start, double dur, double peak) {
        int from = (int) Math.round(start * RATE);
        int to = Math.min(mix.length, (int) Math.round((start + Math.max(0.2, dur)) * RATE));
        for (int i = Math.max(0, from); i < to; i++) {
            double t = (i - from) / (double) RATE;
            mix[i] += (float) (Math.sin(2.0 * Math.PI * freq * t) * gain(t, dur) * peak);
        }
    }

    /** Volume at time t (seconds since the note began), same shape as the Web Audio version. */
    static double gain(double t, double dur) {
        if (t < 0.02) return seg(LOW, 1.0, t, 0.0, 0.02);                       // quick attack
        if (dur > SLOT + 1e-6) {                                                  // held note
            double mid = dur * 0.6, end = dur - 0.02;
            if (t < mid) return seg(1.0, SUSTAIN, t, 0.02, mid);
            if (t < end) return seg(SUSTAIN, LOW, t, mid, end);
            return LOW;
        }
        if (t < 0.18) return seg(1.0, LOW, t, 0.02, 0.18);                      // short pluck
        return LOW;
    }

    private static double seg(double g0, double g1, double t, double ta, double tb) {
        return g0 * Math.pow(g1 / g0, (t - ta) / (tb - ta));
    }
}
