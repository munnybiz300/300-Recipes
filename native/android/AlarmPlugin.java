package com.personal.threehundredrecipes;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Plays the timer alarm on Android's ALARM audio stream, so it follows the phone's
 * alarm volume instead of the media volume. The app (JavaScript) decides which notes to
 * play; this only turns them into sound.
 */
@CapacitorPlugin(name = "Alarm")
public class AlarmPlugin extends Plugin {
    private static final double PEAK = 0.85;

    private static final class Play {
        double[] f, s, d;
    }

    private final Object lock = new Object();
    private volatile AudioTrack track;
    private volatile boolean running = false;

    @PluginMethod
    public void play(PluginCall call) {
        JSArray plays = call.getArray("plays");
        if (plays == null || plays.length() == 0) {
            call.reject("No tune given");
            return;
        }
        try {
            final Play[] list = new Play[plays.length()];
            for (int p = 0; p < list.length; p++) {
                JSONArray notes = plays.getJSONArray(p);
                Play pl = new Play();
                pl.f = new double[notes.length()];
                pl.s = new double[notes.length()];
                pl.d = new double[notes.length()];
                for (int i = 0; i < notes.length(); i++) {
                    JSONObject o = notes.getJSONObject(i);
                    pl.f[i] = o.getDouble("f");
                    pl.s[i] = o.getDouble("s");
                    pl.d[i] = o.getDouble("d");
                }
                list[p] = pl;
            }
            start(list);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start the alarm: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        halt();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        halt();
    }

    private void start(final Play[] list) {
        halt();
        int min = AudioTrack.getMinBufferSize(
                TuneSynth.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        final AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(TuneSynth.RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setBufferSizeInBytes(Math.max(min * 2, 16384))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        synchronized (lock) {
            track = t;
            running = true;
        }
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    t.play();
                    for (Play p : list) {
                        if (!running || track != t) break;
                        short[] pcm = TuneSynth.render(p.f, p.s, p.d, 5.0, PEAK);
                        int off = 0;
                        while (running && track == t && off < pcm.length) {
                            int n = t.write(pcm, off, Math.min(4096, pcm.length - off));
                            if (n <= 0) break;
                            off += n;
                        }
                    }
                    if (running && track == t) Thread.sleep(400); // let the last buffered notes finish
                } catch (Exception ignored) {
                    // stopped or audio unavailable: just end quietly
                } finally {
                    try { t.stop(); } catch (Exception ignored) { }
                    try { t.release(); } catch (Exception ignored) { }
                    synchronized (lock) {
                        if (track == t) { track = null; running = false; }
                    }
                }
            }
        }, "town-tune-alarm");
        worker.setDaemon(true);
        worker.start();
    }

    /** Stops immediately, including audio already queued. */
    private void halt() {
        AudioTrack t;
        synchronized (lock) {
            t = track;
            track = null;
            running = false;
        }
        if (t != null) {
            try { t.pause(); } catch (Exception ignored) { }
            try { t.flush(); } catch (Exception ignored) { }
        }
    }
}
