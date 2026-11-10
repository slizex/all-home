package de.slizex.allhome;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.provider.Settings;

/**
 * App-Symbol hell/dunkel.
 *
 * Das Symbol hat eine values-night-Fassung. Manche Launcher (z. B. ColorOS) zeichnen die Symbole
 * fremder Apps aber nur neu, wenn sich das Paket ändert – nach dem Umschalten bleibt das alte Symbol
 * stehen. Darum: Wechsel erkennen und dem Launcher eine Paketänderung melden, indem die unsichtbare
 * Komponente {@link Anstoss} umgeschaltet wird (die App läuft dabei weiter).
 *
 * Erkannt wird der Wechsel beim Öffnen der App, während sie läuft (onConfigurationChanged) und im
 * Hintergrund über diesen Job, der auf Änderungen der Systemeinstellungen wartet (Dunkelmodus
 * schreibt dort). Fehler bleiben still – das Symbol darf die App nie stören.
 */
public class SymbolFarbe extends JobService {

    private static final String PREFS = "symbol";
    private static final String KEY = "nacht";
    private static final int JOB_ID = 0x5A110001;

    /** Leere Komponente ohne Filter: ihr Umschalten ist für die App wirkungslos, löst aber PACKAGE_CHANGED aus. */
    public static class Anstoss extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {}
    }

    static boolean istNacht(Context ctx) {
        int m = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return m == Configuration.UI_MODE_NIGHT_YES;
    }

    /** Passt das zuletzt gemeldete Symbol zum aktuellen Modus? Sonst Launcher anstoßen. Plant den Job neu. */
    static void pruefen(Context ctx) {
        Context app = ctx.getApplicationContext();
        try {
            boolean nacht = istNacht(app);
            SharedPreferences p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (p.getInt(KEY, -1) != (nacht ? 1 : 0)) {
                anstossen(app);
                p.edit().putInt(KEY, nacht ? 1 : 0).apply();
            }
        } catch (Exception e) {
            // still
        }
        planen(app);
    }

    private static void anstossen(Context app) {
        PackageManager pm = app.getPackageManager();
        ComponentName cn = new ComponentName(app, Anstoss.class);
        int neu = pm.getComponentEnabledSetting(cn) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            ? PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            : PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        pm.setComponentEnabledSetting(cn, neu, PackageManager.DONT_KILL_APP);
    }

    private static void planen(Context app) {
        try {
            JobScheduler js = (JobScheduler) app.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(app, SymbolFarbe.class))
                .addTriggerContentUri(new JobInfo.TriggerContentUri(
                    Settings.Secure.CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .setTriggerContentUpdateDelay(500)
                .setTriggerContentMaxDelay(5000)
                .build();
            js.schedule(job);
        } catch (Exception e) {
            // still
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        pruefen(this);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
