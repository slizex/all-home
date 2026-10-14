# 🏠 All-Home

Alle Verträge, Dokumente und Termine deines Haushalts an einem Ort — eine schlanke PWA
(Handy + Desktop), ohne Build-Schritt: eine einzige `index.html`.

## Was All-Home macht

**Dein Haushalt als Checkliste.** Du hakst einmal ab, welche Vertragsarten es bei dir gibt
(53 Arten in 7 Gruppen — von Strom über KFZ-Versicherung bis Rundfunkbeitrag). Jede
angehakte Art ist danach ein Platz: gefüllt oder sichtbar leer. Nicht Angehaktes
erscheint nirgends.

**Scanner wie in Google Drive.** Live-Sucher mit erkanntem Rahmen und Auto-Auslöser (abschaltbar), Seite um Seite
ohne Unterbrechung. Danach Ecken nachziehen (mit Lupe), drehen, Filter (Auto: Schatten weg und Papier weiß,
Farben bleiben · Original · Graustufen · Schwarzweiß), neu aufnehmen, Reihenfolge per Ziehen. Gespeichert wird
als **ein PDF** oder als **ein Dokument mit mehreren JPG-Seiten**, 200 dpi, A4 bleibt A4. Seiten lassen sich
später anfügen, auch an PDFs vom Anbieter. Beim Scannen am Vertrag zeigt ein **Abgleich**, was die KI gelesen hat
und was im Vertrag steht: leere Felder sind vorab angehakt, abweichende Werte (z. B. ein neuer Preis) nicht.
Der Volltext gescannter Seiten wird für die Suche mitgespeichert. Ausweise legt der Scanner standardmäßig
ohne KI ab. Ein angefangener Scan bleibt als Entwurf nur auf dem Gerät. Ohne Kamerafreigabe geht es über die
Kamera-App oder Fotos aus der Galerie. Langer Druck aufs App-Symbol (Android, PC): „Scannen“.

**Dokumente gehören zum Vertrag.** PDF oder Foto hochladen, die KI liest Anbieter,
Laufzeit, Kündigungsfrist, Kosten und Nummern aus und schlägt die Zuordnung vor.
Gespeichert wird erst, wenn du bestätigst. Alle Dokumente zusammen findest du unter
**Mehr › Dokumente**: mit Suche, dem Filter „Ohne Vertrag“ und einer Auswahl zum gezielten Löschen.

**Sieben Helfer, die mitdenken**
- Kündigungsfristen mit Ampel, Warnung und Kalender-Export
- Vollständigkeits-Check: welche Verträge fehlen dem Haushalt noch
- Preiserhöhung erkannt → Uhr fürs Sonderkündigungsrecht läuft
- Wiederkehrende Pflichttermine: HU/TÜV, Ausweis, Pass, Führerschein, Wartung
- Haushaltskosten je Art plus Markt-Recherche beim größten Posten
- Doppelt-versichert-Warnung
- Dokumenten-Lücken: fehlende Police, Rechnung, Unterlagen

Jeder Helfer ist einzeln abschaltbar.

**Gesundheit** als eigener Bereich: Arztrechnungen und Befunde, Erklärung der
Abrechnungsziffern (GOÄ/GOZ) in Alltagssprache samt verwendeter Materialien, und eine
Steuerübersicht als CSV — nach Person getrennt.

**Nebenkostenabrechnung, Jahr für Jahr.** Unter Mehr › Nebenkosten und am Mietvertrag: Abrechnung scannen,
hochladen oder von Hand eintragen. Die KI liest jede Position mit Kategorie nach § 2 BetrKV, Verteilerschlüssel,
Hauskosten und Anteil aus, dazu Wohnfläche, Vorauszahlungen, Ergebnis und die Heizkosten-Angaben. Alles bleibt
von Hand änderbar. Je Abrechnungszeitraum gibt es genau eine Abrechnung („2025“ oder „2024/25“). Eine Korrektur
ersetzt die Werte, die Dokumente bleiben erhalten. Kürzere Zeiträume werden für den Vergleich auf 12 Monate
hochgerechnet. Die Übersicht zeigt Kennzahlen, gestapelte Säulen je Kategorie, Euro je m² und Monat gegen den
[Betriebskostenspiegel](https://mieterbund.de/aktuelles/meldungen/mieterbund-veroeffentlicht-aktuellen-betriebskostenspiegel-fuer-deutschland/)
des Mieterbunds, eine Tabelle Kategorie × Jahr und die Kostentreiber. Geprüft wird ohne KI, mit festen Regeln:
- **Fristen:** § 556 Abs. 3 BGB für Abrechnung und Einwände
- **Umlagefähigkeit:** Verwaltung, Reparaturen, gemietete Rauchmelder, Kabel-TV ab 1.7.2024
- **Heizkosten:** Kürzungsrechte in Euro für die 15 %-Regel, fehlende CO2-Aufteilung und fehlende monatliche
  Verbrauchsinfo
- **Vergleich:** Vergleich mit dem Vorjahr und Vorschlag für die Vorauszahlung
- **Steuer:** § 35a EStG mit CSV-Ausgabe

Eine KI-Einschätzung über alle Jahre gibt es auf Knopfdruck.
Die Vorauszahlung zählt zu den Haushaltskosten. Fristen und offene Nachzahlungen erscheinen auf der Startseite.

**Mehrere Häuser, mehrere Menschen.** Ein Konto kann mehrere Häuser mit Adresse führen
(Wohnung, Ferienhaus, Elternhaus) und oben per Tipp auf den Namen wechseln. Mitglieder
kommen per Einladungscode dazu; Admins verwalten Haus, Rollen und Einladungen. Es gibt
immer mindestens einen Admin — das erzwingt die Datenbank selbst.

**Anbieter-Logos.** Rund 85 deutsche Versicherer, Krankenkassen, Versorger, Banken, Mobilfunker
und Streamingdienste liegen als 128-px-Bilder unter `logos/`; dazu ~50 Marken aus
[Simple Icons](https://simpleicons.org) (CC0), direkt eingebettet. Welches Logo zu welchem Anbieter
gehört, steht im Verzeichnis `butler.anbieter_logos` (Suchwörter). **App-Admins** pflegen es in der
App unter Mehr › Anbieter-Logos: Anbieter ohne Logo werden aufgelistet, ein Logo lässt sich von der
Website holen (Edge Function `allhome-logo`) oder als Bild hochladen (Bucket `anbieter-logos`).

**Fahrzeuge auf einen Blick.** Bei KFZ-Versicherung, Fahrzeug, Leasing und KFZ-Steuer stehen
Kennzeichen (als Schild), Marke und Modell direkt am Vertrag. FIN und Schlüsselnummern (HSN/TSN)
aus dem Fahrzeugschein werden mit ausgelesen.

**Drei KI-Stufen wie in AllTrack:** Schnell (Haiku 4.5) · Gründlich (Sonnet 5.5) · Maximal (Opus 5.5),
wählbar direkt beim Einlesen und unter Mehr. **Admins** sehen unter Mehr › KI-Kosten, wann wer welche
Auswertung gemacht hat und was sie gekostet hat (gemeinsames Protokoll mit AllTrack).

**Felder, die zur Art passen.** Jede der 53 Arten hat ein Profil: Ausweise und Fahrzeuge zeigen keine
Kosten oder Kündigungsfristen, Rundfunk und Steuern keine Laufzeit, Versicherungen heißen „Versicherer“
und „Beitrag“. Pflichtangaben sind dezent mit * markiert, übliche Fristen stehen als Platzhalter im Feld.

**Zweisprachig** Deutsch/Russisch, umschaltbar pro Benutzer. Deutsche Fachbegriffe
stehen in Klammern hinter der Übersetzung, damit man sie auf dem Papier wiedererkennt.

## Verhältnis zu AllTrack (optional)

All-Home funktioniert ohne [AllTrack](https://github.com/slizex/verbrauchs-tracker). Strom, Gas und
Wasser sind dann ganz normale Vertragsarten — eintragen, Dokumente hochladen, Fristen verfolgen.

Wer AllTrack nutzt, kann je Haus die **AllTrack-Verbindung** einschalten (Mehr › Haushalt):
Automatisch (Standard, an sobald AllTrack für das Haus Tarife hat), An oder Aus. Ist sie an,
**spiegelt** All-Home den aktuellen Tarif, zeigt ihn an und verlinkt dorthin — keine Doppelpflege.
Eigene Einträge derselben Art bleiben sichtbar, zählen dann aber nicht doppelt zu den Kosten.

Beide Apps teilen Anmeldung und Haushalte (gleiches Supabase-Projekt, gleiche Domäne).

## Technik

- Eine `index.html`, kein Build. Design und Rahmen aus AllTrack (Nunito, warme Palette).
- Supabase: Schema `butler` (Verträge, Dokumente, Personen, Einrichtung, Nebenkostenabrechnungen),
  Haushalte aus `public` wiederverwendet, privater Bucket `butler-documents`.
- Edge Functions: `butler-extract` (auslesen; Seitenbilder eines Scans in einem Aufruf, Modus `text` für den Volltext, Modi `nk` und `nk-bewertung` für Nebenkostenabrechnungen), `butler-research` (Markt),
  `butler-med-explain` (Abrechnungsziffern), `butler-translate` (Nachübersetzen) –
  mit gemeinsamem Kern `gemeinsam.ts` (Anmeldung, Limits, Kosten in `public.ai_calls`).
- Scanner ohne fremde Bibliothek: Kantenerkennung (Canny + Hough + Vierecks-Bewertung), Entzerrung über
  Homographie mit Seitenverhältnis aus der Perspektive (Zhang/He), Filter und PDF-Schreiber im eigenen Code.
  Nur fürs Anfügen an vorhandene PDFs lädt die App bei Bedarf pdf-lib 1.17.1 (feste Version, SRI).
- PWA mit network-first Service Worker.
- Sicherheit: Content-Security-Policy mit Skript-Hashes (setzt der Build), supabase-js mit fester
  Version und Prüfsumme (SRI), KI-Funktionen nur für angemeldete Nutzer mit Tageslimit und
  Tagesbudget, Datenbank verhindert Zuordnungen über Hausgrenzen.
