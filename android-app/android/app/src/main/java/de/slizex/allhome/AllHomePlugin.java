package de.slizex.allhome;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;

/**
 * Native Funktionen von All-Home. Die Website (slizex.github.io/all-home) ruft sie über
 * Capacitor.Plugins.AllHome auf; im Browser gibt es dieses Plugin nicht.
 *
 * Sperre        – Fingerabdruck/Gesicht, ersatzweise Geräte-PIN; beim Start und nach 5 Minuten im Hintergrund
 * Schutz        – keine Screenshots, keine Vorschau in der App-Übersicht (FLAG_SECURE), Standard an
 * Scanner       – Googles Dokumentenscanner (ML Kit), Seiten einzeln als JPEG abholbar
 * Teilen an     – PDFs und Bilder aus anderen Apps, einzeln abholbar, Ereignis „geteilt“
 * Dateien       – „Speichern unter“ (Android-Dialog) und „Öffnen mit / Teilen“ über eine private Kopie
 * PDF-Ansicht   – Seiten mit Androids eigenem PDF-Renderer als JPEG, ohne Kopie in „Downloads“
 * Update        – APK nur aus dem Release von slizex/all-home, Prüfsumme + gleiche Signatur, dann Android-Installer
 */
@CapacitorPlugin(name = "AllHome")
public class AllHomePlugin extends Plugin {

    private static final String PREFS = "allhome_app";
    private static final String K_SPERRE = "sperre";
    private static final String K_SCHUTZ = "bildschirmschutz";
    private static final String K_EINGERICHTET = "eingerichtet";
    private static final long SPERRE_NACH_MS = 5L * 60L * 1000L;
    private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private static final String APP_HOST = "slizex.github.io";
    private static final String APP_PFAD = "/all-home";
    private static final String UPDATE_QUELLE = "https://github.com/slizex/all-home/releases/download/";
    private static final long UPDATE_MAX = 150L * 1024L * 1024L;
    private static final long GETEILT_MAX = 50L * 1024L * 1024L;
    private static final int GETEILT_ANZAHL = 20;

    private SharedPreferences prefs;

    /* Sperre */
    private FrameLayout sperrEbene;
    private boolean gesperrt = false;
    private boolean pruefungLaeuft = false;
    private boolean sperreBeimStart = false;
    private long hintergrundSeit = 0;

    /* Scanner */
    private ActivityResultLauncher<IntentSenderRequest> scanStarter;
    private PluginCall scanAufruf;
    private final List<Uri> scanSeiten = new ArrayList<>();

    /* Geteilte Dateien */
    private static class Geteilt {

        final File datei;
        final String name;
        final String mime;

        Geteilt(File datei, String name, String mime) {
            this.datei = datei;
            this.name = name;
            this.mime = mime;
        }
    }

    private final List<Geteilt> geteilt = new ArrayList<>();

    /* PDF-Ansicht – alle Zugriffe laufen nacheinander über execute() */
    private PdfRenderer pdf;
    private ParcelFileDescriptor pdfDatei;

    @Override
    public void load() {
        prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        schutzAnwenden(prefs.getBoolean(K_SCHUTZ, true));
        scanStarter = bridge.registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::scanErgebnis);
        aufraeumen(ordner("teilen"), 0);
        aufraeumen(ordner("geteilt"), 0);
        aufraeumen(ordner("updates"), 0);
        aufraeumen(ordner("ansicht"), 0);
        if (sperreAktiv()) {
            sperrEbeneZeigen();
            sperreBeimStart = true;
        }
    }

    /* ================= Allgemein ================= */

    @PluginMethod
    public void info(PluginCall call) {
        JSObject o = new JSObject();
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            o.put("version", pi.versionName);
            o.put("code", versionsNummer(pi));
        } catch (Exception e) {
            o.put("version", "");
            o.put("code", 0);
        }
        o.put("android", Build.VERSION.SDK_INT);
        o.put("sperre", prefs.getBoolean(K_SPERRE, false));
        o.put("sperreMoeglich", sperreMoeglich());
        o.put("schutz", prefs.getBoolean(K_SCHUTZ, true));
        o.put("eingerichtet", prefs.getBoolean(K_EINGERICHTET, false));
        o.put("installErlaubt", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(o);
    }

    @PluginMethod
    public void eingerichtet(PluginCall call) {
        prefs.edit().putBoolean(K_EINGERICHTET, true).apply();
        call.resolve();
    }

    /** Andere Seiten auf slizex.github.io (z. B. AllTrack) öffnen im Browser, nicht in der App. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || !"https".equals(url.getScheme()) || !APP_HOST.equals(url.getHost())) return null;
        String pfad = url.getPath() == null ? "" : url.getPath();
        if (pfad.equals(APP_PFAD) || pfad.startsWith(APP_PFAD + "/")) return null;
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            // kein Browser – dann eben nichts
        }
        return true;
    }

    /* ================= Bildschirmschutz ================= */

    @PluginMethod
    public void schutzSetzen(PluginCall call) {
        boolean an = Boolean.TRUE.equals(call.getBoolean("an", true));
        prefs.edit().putBoolean(K_SCHUTZ, an).apply();
        schutzAnwenden(an);
        JSObject o = new JSObject();
        o.put("an", an);
        call.resolve(o);
    }

    private void schutzAnwenden(boolean an) {
        Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (an) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        });
    }

    /* ================= App-Sperre ================= */

    private boolean sperreMoeglich() {
        return BiometricManager.from(getContext()).canAuthenticate(AUTH) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    /* Hat jemand die Bildschirmsperre des Handys entfernt, sperrt die App nicht mehr – sonst käme man nie wieder hinein. */
    private boolean sperreAktiv() {
        return prefs.getBoolean(K_SPERRE, false) && sperreMoeglich();
    }

    @PluginMethod
    public void sperreSetzen(PluginCall call) {
        boolean an = Boolean.TRUE.equals(call.getBoolean("an", false));
        if (!an) {
            prefs.edit().putBoolean(K_SPERRE, false).apply();
            JSObject o = new JSObject();
            o.put("an", false);
            call.resolve(o);
            return;
        }
        if (!sperreMoeglich()) {
            JSObject o = new JSObject();
            o.put("an", false);
            o.put("grund", "nicht-moeglich");
            call.resolve(o);
            return;
        }
        getActivity().runOnUiThread(() ->
            authentifizieren(
                "Sperre einschalten",
                () -> {
                    prefs.edit().putBoolean(K_SPERRE, true).apply();
                    JSObject o = new JSObject();
                    o.put("an", true);
                    call.resolve(o);
                },
                grund -> {
                    JSObject o = new JSObject();
                    o.put("an", false);
                    o.put("grund", grund);
                    call.resolve(o);
                }
            )
        );
    }

    @Override
    protected void handleOnPause() {
        if (!pruefungLaeuft && !gesperrt) hintergrundSeit = SystemClock.elapsedRealtime();
    }

    @Override
    protected void handleOnResume() {
        if (pruefungLaeuft) return;
        if (sperreBeimStart) {
            sperreBeimStart = false;
            hintergrundSeit = 0;
            entsperrenVersuchen();
            return;
        }
        if (gesperrt) {
            entsperrenVersuchen();
            return;
        }
        if (hintergrundSeit > 0 && sperreAktiv() && SystemClock.elapsedRealtime() - hintergrundSeit >= SPERRE_NACH_MS) {
            sperrEbeneZeigen();
            entsperrenVersuchen();
        }
        hintergrundSeit = 0;
    }

    private void entsperrenVersuchen() {
        if (!sperreMoeglich()) {
            entsperren();
            return;
        }
        authentifizieren("All-Home entsperren", this::entsperren, grund -> {});
    }

    private void authentifizieren(String titel, Runnable ok, Consumer<String> abgebrochen) {
        if (pruefungLaeuft) return;
        pruefungLaeuft = true;
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder().setTitle(titel).setAllowedAuthenticators(AUTH).build();
        BiometricPrompt prompt = new BiometricPrompt(
            getActivity(),
            ContextCompat.getMainExecutor(getContext()),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    pruefungLaeuft = false;
                    hintergrundSeit = 0;
                    ok.run();
                }

                @Override
                public void onAuthenticationError(int code, CharSequence text) {
                    pruefungLaeuft = false;
                    abgebrochen.accept(String.valueOf(code));
                }
            }
        );
        try {
            prompt.authenticate(info);
        } catch (Exception e) {
            pruefungLaeuft = false;
            abgebrochen.accept("fehler");
        }
    }

    private void sperrEbeneZeigen() {
        gesperrt = true;
        Activity a = getActivity();
        if (a == null) return;
        if (sperrEbene != null) {
            sperrEbene.setVisibility(View.VISIBLE);
            sperrEbene.bringToFront();
            return;
        }
        boolean dunkel = (a.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int hg = dunkel ? 0xFF15130F : 0xFFF7F4EF;
        int schrift = dunkel ? 0xFFF3EDE4 : 0xFF231F1A;
        int knopfHg = dunkel ? 0xFFF3EDE4 : 0xFF231F1A;
        int knopfSchrift = dunkel ? 0xFF15130F : 0xFFFFFAF2;

        FrameLayout ebene = new FrameLayout(a);
        ebene.setBackgroundColor(hg);
        ebene.setClickable(true);
        ebene.setFocusable(true);
        ebene.setElevation(dp(100));

        LinearLayout spalte = new LinearLayout(a);
        spalte.setOrientation(LinearLayout.VERTICAL);
        spalte.setGravity(Gravity.CENTER_HORIZONTAL);

        ImageView bild = new ImageView(a);
        bild.setImageResource(R.mipmap.ic_launcher);
        spalte.addView(bild, new LinearLayout.LayoutParams(dp(88), dp(88)));

        TextView titel = new TextView(a);
        titel.setText("All-Home ist gesperrt");
        titel.setTextColor(schrift);
        titel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        titel.setTypeface(Typeface.DEFAULT_BOLD);
        titel.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.topMargin = dp(18);
        spalte.addView(titel, tp);

        TextView knopf = new TextView(a);
        knopf.setText("Entsperren");
        knopf.setTextColor(knopfSchrift);
        knopf.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        knopf.setTypeface(Typeface.DEFAULT_BOLD);
        knopf.setGravity(Gravity.CENTER);
        knopf.setPadding(dp(28), 0, dp(28), 0);
        knopf.setMinHeight(dp(48));
        GradientDrawable form = new GradientDrawable();
        form.setColor(knopfHg);
        form.setCornerRadius(dp(14));
        knopf.setBackground(form);
        knopf.setClickable(true);
        knopf.setFocusable(true);
        knopf.setOnClickListener(v -> entsperrenVersuchen());
        LinearLayout.LayoutParams kp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48));
        kp.topMargin = dp(24);
        spalte.addView(knopf, kp);

        ebene.addView(spalte, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        a.addContentView(ebene, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        sperrEbene = ebene;
    }

    private void entsperren() {
        gesperrt = false;
        if (sperrEbene != null) sperrEbene.setVisibility(View.GONE);
        notifyListeners("entsperrt", new JSObject());
        if (!geteilt.isEmpty()) notifyListeners("geteilt", geteiltInfo(), true);
    }

    private int dp(int wert) {
        return Math.round(wert * getContext().getResources().getDisplayMetrics().density);
    }

    /* ================= Google-Dokumentenscanner ================= */

    @PluginMethod
    public void scannen(PluginCall call) {
        if (scanAufruf != null) {
            call.reject("Der Scanner läuft bereits.", "LAEUFT");
            return;
        }
        Integer gewuenscht = call.getInt("seiten", 20);
        int seiten = Math.max(1, Math.min(gewuenscht == null ? 20 : gewuenscht, 40));
        GmsDocumentScannerOptions opt = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(seiten)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(opt);
        scanner
            .getStartScanIntent(getActivity())
            .addOnSuccessListener(sender -> {
                scanAufruf = call;
                try {
                    scanStarter.launch(new IntentSenderRequest.Builder(sender).build());
                } catch (Exception e) {
                    scanAufruf = null;
                    call.reject("Der Scanner ließ sich nicht öffnen.", "NICHT_VERFUEGBAR");
                }
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Scanner nicht verfügbar." : e.getMessage(), "NICHT_VERFUEGBAR"));
    }

    private void scanErgebnis(ActivityResult r) {
        PluginCall call = scanAufruf;
        scanAufruf = null;
        scanSeiten.clear();
        if (call == null) return;
        if (r.getResultCode() == Activity.RESULT_OK && r.getData() != null) {
            GmsDocumentScanningResult e = GmsDocumentScanningResult.fromActivityResultIntent(r.getData());
            if (e != null && e.getPages() != null) {
                for (GmsDocumentScanningResult.Page p : e.getPages()) scanSeiten.add(p.getImageUri());
            }
        }
        JSObject o = new JSObject();
        o.put("seiten", scanSeiten.size());
        call.resolve(o);
    }

    @PluginMethod
    public void scanSeite(PluginCall call) {
        Integer i = call.getInt("i", -1);
        if (i == null || i < 0 || i >= scanSeiten.size()) {
            call.reject("Seite gibt es nicht.", "UNGUELTIG");
            return;
        }
        Uri u = scanSeiten.get(i);
        execute(() -> {
            try {
                JSObject o = new JSObject();
                o.put("daten", Base64.encodeToString(lesen(u, GETEILT_MAX), Base64.NO_WRAP));
                o.put("mime", "image/jpeg");
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Seite konnte nicht gelesen werden.", "LESEN");
            }
        });
    }

    @PluginMethod
    public void scanFertig(PluginCall call) {
        for (Uri u : scanSeiten) {
            if ("file".equals(u.getScheme()) && u.getPath() != null) new File(u.getPath()).delete();
        }
        scanSeiten.clear();
        call.resolve();
    }

    /* ================= An All-Home geteilte Dateien ================= */

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        String aktion = intent.getAction();
        if (!Intent.ACTION_SEND.equals(aktion) && !Intent.ACTION_SEND_MULTIPLE.equals(aktion)) return;
        List<Uri> quellen = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(aktion)) {
            Uri u = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (u != null) quellen.add(u);
        } else {
            ArrayList<Uri> l = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (l != null) quellen.addAll(l);
        }
        intent.setAction(null);
        if (quellen.isEmpty()) return;
        execute(() -> {
            File ziel = ordner("geteilt");
            List<Geteilt> neu = new ArrayList<>();
            int n = 0;
            for (Uri u : quellen) {
                if (neu.size() >= GETEILT_ANZAHL) break;
                try {
                    String mime = getContext().getContentResolver().getType(u);
                    if (mime == null) mime = "";
                    if (!mime.equals("application/pdf") && !mime.startsWith("image/")) continue;
                    String name = sauber(anzeigeName(u), mime.equals("application/pdf") ? "dokument.pdf" : "bild.jpg");
                    File f = new File(ziel, System.currentTimeMillis() + "-" + (n++) + "-" + name);
                    try (OutputStream out = new FileOutputStream(f)) {
                        out.write(lesen(u, GETEILT_MAX));
                    }
                    neu.add(new Geteilt(f, name, mime));
                } catch (Exception e) {
                    // nicht lesbar oder zu groß – überspringen
                }
            }
            if (neu.isEmpty()) return;
            getActivity().runOnUiThread(() -> {
                geteilt.addAll(neu);
                if (!gesperrt) notifyListeners("geteilt", geteiltInfo(), true);
            });
        });
    }

    private JSObject geteiltInfo() {
        JSArray liste = new JSArray();
        for (int i = 0; i < geteilt.size(); i++) {
            Geteilt g = geteilt.get(i);
            JSObject o = new JSObject();
            o.put("i", i);
            o.put("name", g.name);
            o.put("mime", g.mime);
            o.put("groesse", g.datei.length());
            liste.put(o);
        }
        JSObject o = new JSObject();
        o.put("dateien", liste);
        return o;
    }

    @PluginMethod
    public void geteilteDateien(PluginCall call) {
        if (gesperrt) {
            JSObject o = new JSObject();
            o.put("dateien", new JSArray());
            call.resolve(o);
            return;
        }
        call.resolve(geteiltInfo());
    }

    @PluginMethod
    public void geteilteDatei(PluginCall call) {
        Integer i = call.getInt("i", -1);
        if (gesperrt || i == null || i < 0 || i >= geteilt.size()) {
            call.reject("Datei gibt es nicht.", "UNGUELTIG");
            return;
        }
        Geteilt g = geteilt.get(i);
        execute(() -> {
            try {
                JSObject o = new JSObject();
                o.put("name", g.name);
                o.put("mime", g.mime);
                o.put("daten", Base64.encodeToString(lesen(Uri.fromFile(g.datei), GETEILT_MAX), Base64.NO_WRAP));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Datei konnte nicht gelesen werden.", "LESEN");
            }
        });
    }

    @PluginMethod
    public void geteiltFertig(PluginCall call) {
        for (Geteilt g : geteilt) g.datei.delete();
        geteilt.clear();
        call.resolve();
    }

    /* ================= Speichern unter / Öffnen mit / Teilen ================= */

    @PluginMethod
    public void dateiSpeichern(PluginCall call) {
        String name = sauber(call.getString("name"), "datei");
        String mime = call.getString("mime", "application/octet-stream");
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, i, "gespeichert");
    }

    @ActivityCallback
    private void gespeichert(PluginCall call, ActivityResult r) {
        if (call == null) return;
        if (r.getResultCode() != Activity.RESULT_OK || r.getData() == null || r.getData().getData() == null) {
            JSObject o = new JSObject();
            o.put("gespeichert", false);
            call.resolve(o);
            return;
        }
        Uri ziel = r.getData().getData();
        String daten = call.getString("daten", "");
        execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(ziel)) {
                if (out == null) throw new Exception("kein Ziel");
                out.write(Base64.decode(daten, Base64.DEFAULT));
                JSObject o = new JSObject();
                o.put("gespeichert", true);
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Die Datei konnte nicht gespeichert werden.", "SPEICHERN");
            }
        });
    }

    /** art = "oeffnen" (Öffnen mit …) oder "teilen" (Teilen …). Die Kopie liegt nur im privaten Cache und wird aufgeräumt. */
    @PluginMethod
    public void dateiWeitergeben(PluginCall call) {
        String name = sauber(call.getString("name"), "datei");
        String mime = call.getString("mime", "application/octet-stream");
        String daten = call.getString("daten", "");
        boolean oeffnen = "oeffnen".equals(call.getString("art", "teilen"));
        execute(() -> {
            try {
                File ordner = ordner("teilen");
                aufraeumen(ordner, 10L * 60L * 1000L);
                File f = new File(ordner, name);
                try (OutputStream out = new FileOutputStream(f)) {
                    out.write(Base64.decode(daten, Base64.DEFAULT));
                }
                Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent i;
                if (oeffnen) {
                    i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(u, mime);
                } else {
                    i = new Intent(Intent.ACTION_SEND);
                    i.setType(mime);
                    i.putExtra(Intent.EXTRA_STREAM, u);
                }
                i.setClipData(ClipData.newRawUri(name, u));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent wahl = Intent.createChooser(i, oeffnen ? "Öffnen mit" : "Teilen");
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(wahl);
                        call.resolve();
                    } catch (ActivityNotFoundException e) {
                        call.reject("Keine passende App gefunden.", "KEINE_APP");
                    }
                });
            } catch (Exception e) {
                call.reject("Die Datei konnte nicht weitergegeben werden.", "WEITERGEBEN");
            }
        });
    }

    /* ================= PDF-Ansicht ================= */

    @PluginMethod
    public void pdfOeffnen(PluginCall call) {
        String daten = call.getString("daten", "");
        execute(() -> {
            pdfZu();
            try {
                File f = new File(ordner("ansicht"), "ansicht.pdf");
                try (OutputStream out = new FileOutputStream(f)) {
                    out.write(Base64.decode(daten, Base64.DEFAULT));
                }
                pdfDatei = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
                pdf = new PdfRenderer(pdfDatei);
                JSObject o = new JSObject();
                o.put("seiten", pdf.getPageCount());
                call.resolve(o);
            } catch (Exception e) {
                pdfZu();
                call.reject("Dieses PDF lässt sich nicht anzeigen (vielleicht mit Passwort geschützt).", "PDF");
            }
        });
    }

    /** Eine Seite als JPEG in der gewünschten Breite (Pixel, höchstens 2400). */
    @PluginMethod
    public void pdfSeite(PluginCall call) {
        Integer i = call.getInt("i", 0);
        Integer b = call.getInt("breite", 1200);
        execute(() -> {
            if (pdf == null || i == null || i < 0 || i >= pdf.getPageCount()) {
                call.reject("Seite gibt es nicht.", "UNGUELTIG");
                return;
            }
            try (PdfRenderer.Page seite = pdf.openPage(i)) {
                int w = Math.max(200, Math.min(b == null ? 1200 : b, 2400));
                int h = Math.max(1, Math.round(w * (float) seite.getHeight() / (float) seite.getWidth()));
                if (h > 6000) {
                    w = Math.round(w * 6000f / h);
                    h = 6000;
                }
                Bitmap bild = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                bild.eraseColor(Color.WHITE);
                seite.render(bild, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bild.compress(Bitmap.CompressFormat.JPEG, 88, out);
                bild.recycle();
                JSObject o = new JSObject();
                o.put("daten", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                o.put("breite", w);
                o.put("hoehe", h);
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Seite konnte nicht gezeichnet werden.", "PDF");
            }
        });
    }

    @PluginMethod
    public void pdfSchliessen(PluginCall call) {
        execute(() -> {
            pdfZu();
            call.resolve();
        });
    }

    private void pdfZu() {
        try {
            if (pdf != null) pdf.close();
        } catch (Exception e) {
            // schon zu
        }
        try {
            if (pdfDatei != null) pdfDatei.close();
        } catch (Exception e) {
            // schon zu
        }
        pdf = null;
        pdfDatei = null;
        aufraeumen(ordner("ansicht"), 0);
    }

    /* ================= App-Update ================= */

    @PluginMethod
    public void appAktualisieren(PluginCall call) {
        String url = call.getString("url", "");
        String sha = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        if (!url.startsWith(UPDATE_QUELLE) || !sha.matches("[0-9a-f]{64}")) {
            call.reject("Ungültige Update-Angabe.", "UNGUELTIG");
            return;
        }
        execute(() -> {
            File apk = updateDatei();
            apk.delete();
            try {
                herunterladen(url, apk);
                if (!sha.equals(sha256(apk))) throw new Exception("Die Prüfsumme des Updates stimmt nicht.");
                apkPruefen(apk);
                getActivity().runOnUiThread(() -> installieren(call));
            } catch (Exception e) {
                apk.delete();
                call.reject(e.getMessage() == null ? "Update fehlgeschlagen." : e.getMessage(), "UPDATE");
            }
        });
    }

    private File updateDatei() {
        return new File(ordner("updates"), "all-home-update.apk");
    }

    private void installieren(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, i, "installErlaubnis");
            return;
        }
        installerStarten(call);
    }

    @ActivityCallback
    private void installErlaubnis(PluginCall call, ActivityResult r) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject o = new JSObject();
            o.put("status", "keine-erlaubnis");
            call.resolve(o);
            return;
        }
        installerStarten(call);
    }

    private void installerStarten(PluginCall call) {
        File apk = updateDatei();
        if (!apk.exists()) {
            call.reject("Das Update ist nicht mehr da – bitte erneut tippen.", "UPDATE");
            return;
        }
        Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(i);
            JSObject o = new JSObject();
            o.put("status", "installer");
            call.resolve(o);
        } catch (ActivityNotFoundException e) {
            call.reject("Der Android-Installer wurde nicht gefunden.", "UPDATE");
        }
    }

    /** Lädt nur über HTTPS, folgt höchstens fünf Weiterleitungen (GitHub → Speicherdienst) und meldet den Fortschritt. */
    private void herunterladen(String adresse, File ziel) throws Exception {
        URL u = new URL(adresse);
        HttpURLConnection con;
        int weiter = 0;
        while (true) {
            con = (HttpURLConnection) u.openConnection();
            con.setInstanceFollowRedirects(false);
            con.setConnectTimeout(15000);
            con.setReadTimeout(30000);
            int code = con.getResponseCode();
            if (code >= 300 && code < 400) {
                String ort = con.getHeaderField("Location");
                con.disconnect();
                if (ort == null || ++weiter > 5) throw new Exception("Der Download wurde zu oft umgeleitet.");
                u = new URL(u, ort);
                if (!"https".equals(u.getProtocol())) throw new Exception("Der Download ist nicht verschlüsselt.");
                continue;
            }
            if (code != 200) {
                con.disconnect();
                throw new Exception("Der Download ist fehlgeschlagen (" + code + ").");
            }
            break;
        }
        long gesamt = con.getContentLengthLong();
        if (gesamt > UPDATE_MAX) {
            con.disconnect();
            throw new Exception("Das Update ist zu groß.");
        }
        try (InputStream in = new BufferedInputStream(con.getInputStream()); OutputStream out = new FileOutputStream(ziel)) {
            byte[] puffer = new byte[65536];
            long geladen = 0;
            long gemeldet = 0;
            int n;
            while ((n = in.read(puffer)) > 0) {
                out.write(puffer, 0, n);
                geladen += n;
                if (geladen > UPDATE_MAX) throw new Exception("Das Update ist zu groß.");
                if (geladen - gemeldet >= 262144) {
                    gemeldet = geladen;
                    JSObject p = new JSObject();
                    p.put("geladen", geladen);
                    p.put("gesamt", gesamt);
                    notifyListeners("updateFortschritt", p);
                }
            }
        } finally {
            con.disconnect();
        }
    }

    /** Gleiche App, neuere Version, gleicher Signaturschlüssel – sonst wird nichts installiert. */
    private void apkPruefen(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo neu = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (neu == null) throw new Exception("Die Datei ist keine gültige App.");
        if (!getContext().getPackageName().equals(neu.packageName)) throw new Exception("Das Update gehört nicht zu All-Home.");
        PackageInfo alt = pm.getPackageInfo(getContext().getPackageName(), flags);
        if (versionsNummer(neu) <= versionsNummer(alt)) throw new Exception("Das Update ist nicht neuer als die installierte App.");
        Set<String> a = zertifikate(alt);
        if (a.isEmpty() || !a.equals(zertifikate(neu))) throw new Exception("Das Update ist nicht mit dem Schlüssel von All-Home signiert.");
    }

    @SuppressWarnings("deprecation")
    private Set<String> zertifikate(PackageInfo pi) throws Exception {
        Signature[] s;
        if (Build.VERSION.SDK_INT >= 28) {
            if (pi.signingInfo == null) return Collections.emptySet();
            s = pi.signingInfo.hasMultipleSigners() ? pi.signingInfo.getApkContentsSigners() : pi.signingInfo.getSigningCertificateHistory();
        } else {
            s = pi.signatures;
        }
        Set<String> m = new HashSet<>();
        if (s != null) for (Signature x : s) m.add(hex(MessageDigest.getInstance("SHA-256").digest(x.toByteArray())));
        return m;
    }

    @SuppressWarnings("deprecation")
    private static long versionsNummer(PackageInfo pi) {
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    /* ================= Hilfen ================= */

    private File ordner(String name) {
        File f = new File(getContext().getCacheDir(), name);
        if (!f.exists()) f.mkdirs();
        return f;
    }

    private static void aufraeumen(File ordner, long aelterAlsMs) {
        File[] liste = ordner.listFiles();
        if (liste == null) return;
        long grenze = System.currentTimeMillis() - aelterAlsMs;
        for (File f : liste) if (f.isFile() && (aelterAlsMs <= 0 || f.lastModified() < grenze)) f.delete();
    }

    private byte[] lesen(Uri u, long max) throws Exception {
        try (InputStream in = "file".equals(u.getScheme()) ? new FileInputStream(new File(u.getPath())) : getContext().getContentResolver().openInputStream(u)) {
            if (in == null) throw new Exception("nicht lesbar");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] puffer = new byte[65536];
            long summe = 0;
            int n;
            while ((n = in.read(puffer)) > 0) {
                summe += n;
                if (summe > max) throw new Exception("zu groß");
                out.write(puffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private String anzeigeName(Uri u) {
        try (Cursor c = getContext().getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            // ohne Namen weiter
        }
        return u.getLastPathSegment();
    }

    /** Dateiname ohne Pfadteile und Sonderzeichen, höchstens 120 Zeichen. */
    private static String sauber(String name, String ersatz) {
        if (name == null) return ersatz;
        String n = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) return ersatz;
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] puffer = new byte[65536];
            int n;
            while ((n = in.read(puffer)) > 0) md.update(puffer, 0, n);
        }
        return hex(md.digest());
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }
}
