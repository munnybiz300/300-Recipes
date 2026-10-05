package com.personal.threehundredrecipes;

/**
 * Renders one play of the alarm tune as 16-bit mono PCM. Each note is a few "partials"
 * (the note's pitch times 1, 2, 3...), each with its own strike, gentle fade and short release:
 * the same shape the Web Audio version in www/js/native.js draws. The app sends the
 * instrument (already leveled so nothing clips), so the settings there are the only place
 * to change it. Pure Java, so it can be tested anywhere.
 */
final class TuneSynth {
    static final int RATE = 22050;
    private static final double LOW = 0.0001; // "silence" level, same as the Web Audio version

    private TuneSynth() {}

    /**
     * freq[i] Hz, start[i] and dur[i] in seconds. partials[k] = { pitch multiple, amplitude, fade per second }.
     * The result is exactly `seconds` long.
     */
    static short[] render(double[] freq, double[] start, double[] dur, double seconds,
                          double[][] partials, double attack, double release) {
        int total = (int) Math.round(seconds * RATE);
        float[] mix = new float[total];
        for (int n = 0; n < freq.length; n++) {
            for (double[] p : partials) addPartial(mix, freq[n] * p[0], start[n], dur[n], p[1], p[2], attack, release);
        }
        short[] out = new short[total];
        for (int i = 0; i < total; i++) {
            double v = Math.max(-1.0, Math.min(1.0, mix[i])); // safety only: the app levels it to stay below 1
            out[i] = (short) Math.round(v * 32767.0);
        }
        return out;
    }

    private static void addPartial(float[] mix, double freq, double start, double dur, double amp,
                                   double fade, double attack, double release) {
        if (amp <= LOW) return;
        int from = (int) Math.round(start * RATE);
        int to = Math.min(mix.length, (int) Math.round((start + dur) * RATE));
        double rel = Math.min(release, dur * 0.3);
        double end = dur - rel;
        double endLevel = Math.max(LOW * 2, amp * Math.exp(-fade * (end - attack)));
        for (int i = Math.max(0, from); i < to; i++) {
            double t = (i - from) / (double) RATE;
            double g;
            if (t < attack) g = seg(LOW, amp, t, 0.0, attack);           // strike
            else if (t < end) g = seg(amp, endLevel, t, attack, end);    // ring, fading gently
            else g = seg(endLevel, LOW, t, end, dur);                    // release, no click
            mix[i] += (float) (Math.sin(2.0 * Math.PI * freq * t) * g);
        }
    }

    private static double seg(double g0, double g1, double t, double ta, double tb) {
        return g0 * Math.pow(g1 / g0, (t - ta) / (tb - ta));
    }
}
