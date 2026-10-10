# 🏠 All-Home

Alle Verträge, Dokumente und Termine deines Haushalts an einem Ort — eine schlanke PWA
(Handy + Desktop), ohne Build-Schritt: eine einzige `index.html`.

## Was All-Home macht

**Dein Haushalt als Checkliste.** Du hakst einmal ab, welche Vertragsarten es bei dir gibt
(53 Arten in 7 Gruppen — von Strom über KFZ-Versicherung bis Rundfunkbeitrag). Jede
angehakte Art ist danach ein Platz: gefüllt oder sichtbar leer. Nicht Angehaktes
erscheint nirgends.

**Dokumente gehören zum Vertrag.** PDF oder Foto hochladen, die KI liest Anbieter,
Laufzeit, Kündigungsfrist, Kosten und Nummern aus und schlägt die Zuordnung vor.
Gespeichert wird erst, wenn du bestätigst.

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

**Mehrere Häuser, mehrere Menschen.** Ein Konto kann mehrere Häuser mit Adresse führen
(Wohnung, Ferienhaus, Elternhaus) und oben per Tipp auf den Namen wechseln. Mitglieder
kommen per Einladungscode dazu; Admins verwalten Haus, Rollen und Einladungen. Es gibt
immer mindestens einen Admin — das erzwingt die Datenbank selbst.

**Anbieter-Logos** bekannter Marken (Telekom, Vodafone, O2, Banken, Streaming, Autohersteller)
aus [Simple Icons](https://simpleicons.org) (CC0), direkt eingebettet — es wird kein fremder
Server gefragt, bei wem der Haushalt Kunde ist.

**Zweisprachig** Deutsch/Russisch, umschaltbar pro Benutzer. Deutsche Fachbegriffe
stehen in Klammern hinter der Übersetzung, damit man sie auf dem Papier wiedererkennt.

## Verhältnis zu AllTrack

Strom, Gas und Wasser werden in [AllTrack](https://github.com/slizex/verbrauchs-tracker)
geführt — mit Tarifen, Ablesungen und Jahresabrechnung. All-Home **spiegelt** sie nur:
es zeigt den aktuellen Stand und verlinkt dorthin. Keine Doppelpflege.

Beide Apps teilen Anmeldung und Haushalte (gleiches Supabase-Projekt, gleiche Domäne).

## Technik

- Eine `index.html`, kein Build. Design und Rahmen aus AllTrack (Nunito, warme Palette).
- Supabase: Schema `butler` (Verträge, Dokumente, Personen, Einrichtung),
  Haushalte aus `public` wiederverwendet, privater Bucket `butler-documents`.
- Edge Functions: `butler-extract` (auslesen), `butler-research` (Markt),
  `butler-med-explain` (Abrechnungsziffern), `butler-translate` (Nachübersetzen).
- PWA mit network-first Service Worker.
