#!/usr/bin/env bash
# Rauchtest der All-Home-App im Android-Emulator (GitHub Actions, Abbild google_apis = adb root).
#  1. ohne Netz      → Offline-Seite aus der APK
#  2. mit Netz       → All-Home-Anmeldung live, Versionszeile beweist Brücke + Plugin „AllHome“
#  3. dunkel         → Darstellung im Nachtmodus
#  4. Schutz an      → FLAG_SECURE am Fenster
#  5. Sperre an      → Sperrbild + Geräte-PIN, danach wieder die Anmeldung
#  6. Verknüpfung, Teilen ohne Datei → kein Absturz
# Bildschirmfotos (ohne Bildschirmschutz) und Bildschirmtexte landen in emulator-ergebnis/.
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
text() { adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1; adb exec-out cat /sdcard/ui.xml > "$OUT/$1.xml"; }
hat() { grep -q "$2" "$OUT/$1.xml"; }
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
adb logcat -c

# 1. ohne Netz
prefs false false
adb shell svc wifi disable; adb shell svc data disable; sleep 3
starten; sleep 12
text 1-offline; foto 1-offline
if hat 1-offline "Keine Verbindung"; then ok "Ohne Netz: Offline-Seite"; else nein "Ohne Netz: Offline-Seite fehlt"; fi

# 2. mit Netz – die Offline-Seite versucht es selbst wieder
adb shell svc wifi enable; adb shell svc data enable
for i in $(seq 1 18); do sleep 5; text 2-anmeldung; if hat 2-anmeldung "Anmelden"; then break; fi; done
sleep 2; text 2-anmeldung; foto 2-anmeldung
if hat 2-anmeldung "Anmelden"; then ok "Mit Netz: All-Home-Anmeldung geladen"; else nein "Mit Netz: Anmeldung nicht geladen"; fi
if hat 2-anmeldung "All-Home-App"; then ok "Brücke und Plugin AllHome laufen (Versionszeile)"; else nein "Versionszeile fehlt – Brücke oder Plugin?"; fi

# 3. dunkel
adb shell cmd uimode night yes; sleep 1
adb shell am force-stop "$PKG"; starten; sleep 10
foto 3-dunkel
adb shell cmd uimode night no; sleep 1

# 4. Bildschirmschutz
prefs false true
starten; sleep 8
if adb shell dumpsys window windows | grep -A40 "$PKG" | grep "fl=" | grep -q "SECURE"; then ok "Bildschirmschutz: Fenster ist FLAG_SECURE"; else nein "Bildschirmschutz: FLAG_SECURE fehlt"; fi
foto 4-schutz-schwarz

# 5. App-Sperre mit Geräte-PIN
adb shell locksettings set-pin 2580 > /dev/null
prefs true false
starten; sleep 6
text 5-sperre; foto 5-sperre
if hat 5-sperre "All-Home ist gesperrt\|All-Home entsperren\|PIN"; then ok "Sperre: Sperrbild bzw. PIN-Abfrage erscheint"; else nein "Sperre: kein Sperrbild"; fi
adb shell input text 2580; adb shell input keyevent 66; sleep 6
text 6-entsperrt; foto 6-entsperrt
if hat 6-entsperrt "Anmelden" && ! hat 6-entsperrt "All-Home ist gesperrt"; then ok "Sperre: nach PIN wieder offen"; else nein "Sperre: nach PIN nicht offen"; fi
adb shell locksettings clear --old 2580 > /dev/null

# 6. Verknüpfung „Scannen“ und Teilen ohne Datei
prefs false false
adb shell am start -W -a android.intent.action.VIEW -d "allhome://scan" -n "$AKT" > /dev/null; sleep 4
adb shell am start -W -a android.intent.action.SEND -t application/pdf -n "$AKT" > /dev/null; sleep 4
text 7-danach
if hat 7-danach "Anmelden"; then ok "Verknüpfung und Teilen: App bleibt stabil"; else nein "Verknüpfung/Teilen: Anmeldung nicht mehr sichtbar"; fi

# Abstürze
adb logcat -d > "$OUT/logcat.txt"
if grep -E "FATAL EXCEPTION|AndroidRuntime: Process: $PKG" "$OUT/logcat.txt" > "$OUT/absturz.txt"; then
  nein "Absturz: $(grep -m3 -A3 'FATAL EXCEPTION' "$OUT/logcat.txt" | tr '\n' ' ' | cut -c1-400)"
else
  ok "Keine Abstürze im Protokoll"
fi
exit $FEHLER
