package com.personal.threehundredrecipes;

/**
 * Renders one play of the alarm tune as 16-bit mono PCM: a pure sine tone where each note
 * rings for its whole slot (quick attack, gentle fade, short release). Same shape as the
 * Web Audio version in www/js/native.js; the app sends the shape values, so the settings
 * there are the only place to change it. Pure Java, so it can be tested anywhere.
 */
final class TuneSynth {
    static final int RATE = 22050;
    private static final double LOW = 0.0001; // "silence" level, same as the Web Audio version

    private TuneSynth() {}

    /** freq[i] Hz, start[i] and dur[i] in seconds. The result is exactly `seconds` long. */
    static short[] render(double[] freq, double[] start, double[] dur, double seconds,
                          double peak, double brightness, double attack, double release, double ring) {
        int total = (int) Math.round(seconds * RATE);
        float[] mix = new float[total];
        double p = Math.max(0.0002, Math.min(1.0, peak));
        double b = Math.max(0.0, brightness);
        for (int n = 0; n < freq.length; n++) addNote(mix, freq[n], start[n], dur[n], p, b, attack, release, ring);
        short[] out = new short[total];
        for (int i = 0; i < total; i++) {
            double v = Math.max(-1.0, Math.min(1.0, mix[i]));
            out[i] = (short) Math.round(v * 32767.0);
        }
        return out;
    }

    private static void addNote(float[] mix, double freq, double start, double dur, double peak,
                                double bright, double attack, double release, double ring) {
        int from = (int) Math.round(start * RATE);
        int to = Math.min(mix.length, (int) Math.round((start + dur) * RATE));
        for (int i = Math.max(0, from); i < to; i++) {
            double t = (i - from) / (double) RATE;
            double w = 2.0 * Math.PI * freq * t;
            // brightness 0 = pure sine; above 0 mixes in a soft layer one octave up (same total level)
            double tone = (Math.sin(w) + bright * Math.sin(2.0 * w)) / (1.0 + bright);
            mix[i] += (float) (tone * gain(t, dur, peak, attack, release, ring));
        }
    }

    /** Volume at time t (seconds since the note began). */
    static double gain(double t, double dur, double peak, double attack, double release, double ring) {
        double rel = Math.min(release, dur * 0.3);
        double end = dur - rel;
        double endLevel = peak * Math.exp(-ring * (dur - rel));
        if (t < attack) return seg(LOW, peak, t, 0.0, attack);       // quick attack
        if (t < end) return seg(peak, endLevel, t, attack, end);      // rings, fading gently
        if (t < dur) return seg(endLevel, LOW, t, end, dur);          // short release, no click
        return 0.0;
    }

    private static double seg(double g0, double g1, double t, double ta, double tb) {
        return g0 * Math.pow(g1 / g0, (t - ta) / (tb - ta));
    }
}
