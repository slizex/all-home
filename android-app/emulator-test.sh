#!/usr/bin/env bash
# Rauchtest der All-Home-App im Android-Emulator (GitHub Actions, Abbild google_apis = adb root).
#  1. ohne Netz      → Offline-Seite aus der APK
#  2. mit Netz       → All-Home-Anmeldung live, Versionszeile beweist Brücke + Plugin „AllHome“
#  3. dunkel         → Darstellung im Nachtmodus
#  4. Schutz an      → FLAG_SECURE am Fenster
#  5. Sperre an      → PIN-Abfrage, Abbrechen lässt das Sperrbild stehen, „Entsperren“ + PIN öffnet
#  6. Verknüpfung, Teilen ohne Datei → kein Absturz
# Bildschirmfotos (ohne Bildschirmschutz), Bildschirmtexte und ein gefiltertes Protokoll landen in emulator-ergebnis/.
set -u
APK="$1"
PKG=de.slizex.allhome
AKT=$PKG/.MainActivity
OUT=emulator-ergebnis
mkdir -p "$OUT"
FEHLER=0
ok() { echo "::notice title=Emulator::$1"; }
nein() { echo "::error title=Emulator::$1"; FEHLER=1; }
foto() { adb exec-out screencap -p > "$OUT/$1.png"; }
# uiautomator bricht im Emulator gelegentlich ab („Bad file descriptor“) – bis zu dreimal versuchen
text() {
  for v in 1 2 3; do
    adb shell rm -f /sdcard/ui.xml > /dev/null 2>&1
    adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
    adb exec-out cat /sdcard/ui.xml > "$OUT/$1.xml" 2> /dev/null
    if grep -q "<hierarchy" "$OUT/$1.xml"; then return 0; fi
    sleep 2
  done
  return 1
}
hat() { grep -q "$2" "$OUT/$1.xml"; }
# WebView baut seinen Bildschirmtext verzögert auf – bis zu n Sekunden auf das Muster warten
warte() {
  local ende=$((SECONDS + $3))
  while [ $SECONDS -lt $ende ]; do
    if text "$1" && hat "$1" "$2"; then return 0; fi
    sleep 2
  done
  return 1
}
# Mitte eines nativen Elements mit genau diesem Text antippen
tippe() {
  local b
  b=$(tr '>' '\n' < "$OUT/$1.xml" | grep "text=\"$2\"" | grep -o 'bounds="[^"]*"' | head -1 | grep -o '[0-9]\+' | tr '\n' ' ')
  [ -n "$b" ] || return 1
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
vorne() { adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" | sed 's/^ *//' | tr -d '\r'; }
starten() { adb shell am start -W -n "$AKT" > /dev/null; }
# Einstellungen der App direkt setzen (sperre, bildschirmschutz) – nur mit adb root möglich
prefs() {
  adb shell am force-stop "$PKG"
  local u
  u=$(adb shell stat -c %u "/data/data/$PKG" | tr -d '\r')
  printf '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n    <boolean name="sperre" value="%s" />\n    <boolean name="bildschirmschutz" value="%s" />\n    <boolean name="eingerichtet" value="true" />\n</map>\n' "$1" "$2" > /tmp/allhome_app.xml
  adb push /tmp/allhome_app.xml /data/local/tmp/allhome_app.xml > /dev/null
  adb shell "mkdir -p /data/data/$PKG/shared_prefs && cp /data/local/tmp/allhome_app.xml /data/data/$PKG/shared_prefs/allhome_app.xml && chown -R $u:$u /data/data/$PKG/shared_prefs && chmod 771 /data/data/$PKG/shared_prefs && chmod 660 /data/data/$PKG/shared_prefs/allhome_app.xml && restorecon -R /data/data/$PKG/shared_prefs"
}

adb root > /dev/null 2>&1; sleep 3; adb wait-for-device
adb install -r "$APK" > /dev/null || { nein "Installation fehlgeschlagen"; exit 1; }
ok "Installiert: $(adb shell dumpsys package $PKG | grep -m1 versionName | tr -d ' \r') · Android $(adb shell getprop ro.build.version.release | tr -d '\r') · WebView $(adb shell dumpsys package com.google.android.webview | grep -m1 versionName | tr -d ' \r')"
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 1800000
adb shell wm dismiss-keyguard > /dev/null 2>&1
adb logcat -c

# 1. ohne Netz
prefs false false
adb shell svc wifi disable; adb shell svc data disable; sleep 3
starten; sleep 8
warte 1-offline "Keine Verbindung" 20; foto 1-offline
if hat 1-offline "Keine Verbindung"; then ok "Ohne Netz: Offline-Seite"; else nein "Ohne Netz: Offline-Seite fehlt (vorne: $(vorne))"; fi

# 2. mit Netz – die Offline-Seite versucht es selbst wieder
adb shell svc wifi enable; adb shell svc data enable
warte 2-anmeldung "All-Home-App" 90; sleep 1; foto 2-anmeldung
if hat 2-anmeldung "Anmelden"; then ok "Mit Netz: All-Home-Anmeldung geladen"; else nein "Mit Netz: Anmeldung nicht geladen"; fi
if hat 2-anmeldung "All-Home-App"; then ok "Brücke und Plugin AllHome laufen (Versionszeile)"; else nein "Versionszeile fehlt – Brücke oder Plugin?"; fi

# 3. dunkel
adb shell cmd uimode night yes; sleep 1
adb shell am force-stop "$PKG"; starten
warte 3-dunkel "Anmelden" 30; foto 3-dunkel
adb shell cmd uimode night no; sleep 1

# 4. Bildschirmschutz
prefs false true
starten; sleep 8
if adb shell dumpsys window windows | grep -A40 "$PKG" | grep "fl=" | grep -q "SECURE"; then ok "Bildschirmschutz: Fenster ist FLAG_SECURE"; else nein "Bildschirmschutz: FLAG_SECURE fehlt"; fi
foto 4-schutz-schwarz

# 5. App-Sperre mit Geräte-PIN
adb shell locksettings set-pin 2580 > /dev/null
adb shell wm dismiss-keyguard > /dev/null 2>&1
prefs true false
starten; sleep 4
warte 5-sperre "All-Home entsperren" 15; foto 5-sperre
echo "vorne vor PIN: $(vorne)" >> "$OUT/ablauf.txt"
if hat 5-sperre "All-Home entsperren"; then ok "Sperre: PIN-Abfrage erscheint beim Start"; else nein "Sperre: keine Abfrage (vorne: $(vorne))"; fi
# Abfrage abbrechen → das native Sperrbild bleibt; über „Entsperren“ erneut
adb shell input keyevent 4; sleep 2
warte 5c-sperrbild "All-Home ist gesperrt" 10; foto 5c-sperrbild
if hat 5c-sperrbild "All-Home ist gesperrt" && hat 5c-sperrbild "Entsperren"; then ok "Sperre: Abbrechen lässt das Sperrbild stehen"; else nein "Sperre: nach Abbrechen kein Sperrbild"; fi
tippe 5c-sperrbild "Entsperren"; sleep 2
warte 5d-erneut "All-Home entsperren" 10 || nein "Sperre: „Entsperren“ öffnet keine Abfrage"
adb shell input text 2580; sleep 1
adb shell input keyevent 66; sleep 3
echo "vorne nach PIN: $(vorne)" >> "$OUT/ablauf.txt"
warte 6-entsperrt "Anmelden" 20; foto 6-entsperrt
if hat 6-entsperrt "Anmelden" && ! hat 6-entsperrt "All-Home ist gesperrt"; then ok "Sperre: nach PIN wieder offen"; else nein "Sperre: nach PIN nicht offen (vorne: $(vorne))"; fi
adb shell locksettings clear --old 2580 > /dev/null

# 6. Verknüpfung „Scannen“ und Teilen ohne Datei
prefs false false
adb shell am start -W -a android.intent.action.VIEW -d "allhome://scan" -n "$AKT" > /dev/null; sleep 6
adb shell am start -W -a android.intent.action.SEND -t application/pdf -n "$AKT" > /dev/null; sleep 2
warte 7-danach "Anmelden" 20; foto 7-danach
if hat 7-danach "Anmelden"; then ok "Verknüpfung und Teilen: App bleibt stabil"; else nein "Verknüpfung/Teilen: Anmeldung nicht sichtbar (vorne: $(vorne))"; fi

# Protokoll: nur die App, Capacitor, Biometrie/Anmeldedialog, Abstürze, Aktivitäten
adb logcat -d -v time > "$OUT/logcat-voll.txt"
grep -E "$PKG|Capacitor|AllHome|Biometric|AuthController|AuthService|KeyguardManager|ConfirmDeviceCredential|ActivityTaskManager: (START|Displayed)|AndroidRuntime" "$OUT/logcat-voll.txt" | grep -v "UiAutomation" | tail -400 > "$OUT/logcat.txt"
if grep -A3 "FATAL EXCEPTION" "$OUT/logcat-voll.txt" | grep -q "Process: $PKG"; then
  nein "Absturz der App: $(grep -A6 'FATAL EXCEPTION' "$OUT/logcat-voll.txt" | grep -A5 "Process: $PKG" | tr '\n' ' ' | cut -c1-500)"
else
  ok "Keine Abstürze der App im Protokoll"
fi
rm -f "$OUT/logcat-voll.txt"
exit $FEHLER
