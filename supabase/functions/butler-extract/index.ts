// Supabase Edge Function: butler-extract
// Liest Haushalts-Dokumente per Claude aus und liefert strukturierte Felder als JSON.
// v16: nur angemeldete Nutzer, Tageslimit/Budget, jede Auswertung mit Kosten in public.ai_calls.
// v17: Scanner – mehrere Seitenbilder in einem Aufruf (bilder), Modus "text" schreibt den Volltext ab
//      (immer das guenstigste Modell, Protokoll als allhome-text).
// v18: Nebenkosten – "dateien" (PDF und Bilder gemischt), Modus "nk" liest eine Betriebskosten-/
//      Heizkostenabrechnung strukturiert aus, Modus "nk-bewertung" ordnet alle Jahre ein (allhome-nk*).
// v19: Volltext aus Streifen in voller Aufloesung (streifen = Anzahl je Seite, ab = erste Seitennummer),
//      jedes Bild beschriftet; Auftrag mit Lesereihenfolge, Tabellen, Handschrift, Silbentrennung.
// Gemeinsamer Kern (Anmeldung, Limits, Kosten-Protokoll, Claude-Aufruf): gemeinsam.ts

import { ANTHROPIC_API_KEY, antwortText, claude, claudeFehler, cors, json, level, protokoll, pruefeAufruf, repairJson, stufe } from "./gemeinsam.ts";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64_LEN = 20_000_000;
const BILD_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BILDER = 20;

// Kategorien der Betriebskostenverordnung (§ 2 BetrKV), zusammengefasst wie im Betriebskostenspiegel
const NK_KATEGORIEN = "heizung (Heizung, Warmwasser, Heiznebenkosten, Messdienst), wasser (Frischwasser, Abwasser/Entwaesserung, Niederschlagswasser), grundsteuer, muell, strassenreinigung (inkl. Winterdienst), gebaeudereinigung (inkl. Ungezieferbekaempfung), garten, hauswart, versicherung (Gebaeude-, Haftpflicht-, Elementar-), beleuchtung (Allgemeinstrom), aufzug, schornstein, antenne (Gemeinschaftsantenne, Kabel-TV, Glasfaser-Bereitstellungsentgelt), waesche (Gemeinschaftswaschmaschine), sonstige (vertraglich vereinbarte sonstige Betriebskosten, z. B. Dachrinnenreinigung, Rauchmelder-Wartung, Feuerloescher-Pruefung), nicht_umlagefaehig (Verwaltung, Instandhaltung, Reparaturen, Ruecklagen, Bankgebuehren, Porto, Miete von Rauchwarnmeldern oder Messgeraeten nur wenn ausdruecklich Miete)";

const NK_PROMPT = [
  "Du liest eine deutsche Betriebskosten-/Nebenkostenabrechnung fuer Mieter (ggf. mit Heizkostenabrechnung eines Messdienstes wie ista, Techem, Brunata, Minol, Kalo). Mehrere angehaengte Dateien gehoeren zur SELBEN Abrechnung.",
  "Gib AUSSCHLIESSLICH ein JSON-Objekt zurueck (kein Markdown) mit diesen Schluesseln:",
  "- \"vermieter\": Name des Vermieters bzw. der Verwaltung (string|null). \"objekt\": Adresse/Lage der Wohnung (string|null).",
  "- \"zeitraumVon\", \"zeitraumBis\": Abrechnungszeitraum ISO YYYY-MM-DD (Pflicht, wenn erkennbar). \"erstelltAm\": Datum der Abrechnung ISO|null.",
  "- \"wohnflaeche\": Wohnflaeche der Mietwohnung in m2 (Zahl|null). \"gesamtflaeche\": Flaeche des Hauses/der Abrechnungseinheit (Zahl|null). \"personen\": Personenzahl der Wohnung (Zahl|null).",
  "- \"vorauszahlungen\": im Zeitraum geleistete Betriebskosten-Vorauszahlungen gesamt in EUR (Zahl|null).",
  "- \"ergebnis\": Saldo in EUR, POSITIV = Nachzahlung des Mieters, NEGATIV = Guthaben (Zahl|null).",
  "- \"vorauszahlungNeu\": neue monatliche Vorauszahlung in EUR (Zahl|null), \"vorauszahlungNeuAb\": ab wann ISO|null, \"faelligAm\": Faelligkeit der Nachzahlung/Erstattung ISO|null.",
  "- \"positionen\": Array ALLER Kostenpositionen mit dem Anteil des Mieters. Je Eintrag:",
  "  {\"bezeichnung\": wie auf der Abrechnung, \"kategorie\": genau einer dieser Codes: " + NK_KATEGORIEN + ",",
  "   \"hauskosten\": Gesamtkosten des Hauses fuer diese Position (Zahl|null), \"schluessel\": \"flaeche\"|\"personen\"|\"verbrauch\"|\"einheiten\"|\"miteigentum\"|\"direkt\"|\"sonstig\"|null,",
  "   \"anteilText\": Verteilung wie gedruckt, z. B. \"82,50 m2 von 1.240,00 m2\" (string|null), \"betrag\": Anteil des Mieters in EUR (Zahl),",
  "   \"p35a\": \"dienstleistung\" (haushaltsnah: Reinigung, Garten, Hauswart, Winterdienst) | \"handwerk\" (Wartung, Schornsteinfeger, Reparatur) | null, \"p35aBetrag\": ausgewiesener nach § 35a EStG beguenstigter Anteil (Arbeitskosten) des Mieters in EUR (Zahl|null)}.",
  "  Heizung und Warmwasser als EINE oder mehrere Positionen mit kategorie \"heizung\" (der Mieteranteil laut Heizkostenabrechnung). Keine Zwischensummen, keine Vorauszahlungen als Position.",
  "- \"heizung\": {\"energietraeger\": \"gas\"|\"oel\"|\"fernwaerme\"|\"waermepumpe\"|\"pellets\"|\"strom\"|\"sonstig\"|null, \"kosten\": Heiz- und Warmwasserkosten des Mieters EUR|null,",
  "   \"verbrauchsanteilProzent\": verbrauchsabhaengiger Anteil der Heizkosten in % (z. B. 70)|null, \"verbrauch\": Verbrauchswert Heizung (Zahl|null), \"verbrauchEinheit\": \"kWh\"|\"Einheiten\"|\"Striche\"|null, \"warmwasserM3\": Zahl|null,",
  "   \"verbrauchsabhaengig\": true wenn nach Verbrauch abgerechnet, false wenn nur nach Flaeche|null,",
  "   \"co2Ausgewiesen\": true wenn CO2-Kostenaufteilung (CO2KostAufG) ausgewiesen ist, false wenn sie fehlt, null wenn unklar, \"co2KgProM2\": kg CO2 je m2 und Jahr|null, \"co2Stufe\": 1-10|null,",
  "   \"co2MieteranteilProzent\": Zahl|null, \"co2KostenMieter\": EUR|null, \"verbrauchsinfoErhalten\": true/false/null (monatliche Verbrauchsinformation erwaehnt), \"fernablesbar\": true/false/null, \"messdienst\": string|null}",
  "- \"hinweise\": 1-2 Saetze zu Unsicherheiten oder Lesbarkeit, sonst \"\".",
  "Regeln: Betraege BRUTTO in EUR als Zahl mit Punkt als Dezimaltrennzeichen. Nichts erfinden: unbekannt = null. Die Summe der Positionen soll den Gesamtkosten des Mieters entsprechen.",
].join("\n");

const NK_BEWERTUNG = [
  "Du bist ein sachlicher Mieterberater. Unten stehen die ausgewerteten Betriebskostenabrechnungen EINES Mieters ueber mehrere Abrechnungszeitraeume (JSON, Betraege in EUR, je_m2_monat in EUR, spiegel = Durchschnitt laut Betriebskostenspiegel des Deutschen Mieterbunds) samt bereits gerechneter Hinweise.",
  "Ordne die Entwicklung ein: was treibt die Kosten, was ist auffaellig, was sollte der Mieter tun (z. B. Belege einsehen, Einwand erheben, Vorauszahlung anpassen, Verbrauch senken). Keine Rechtsberatung, keine erfundenen Zahlen, nur die gegebenen Daten.",
  "Gib AUSSCHLIESSLICH JSON zurueck: {\"kurz\": 2-3 Saetze Gesamteinschaetzung, \"punkte\": [{\"art\": \"gut\"|\"auffaellig\"|\"handeln\", \"titel\": kurz, \"text\": 1-2 Saetze}] (3-7 Eintraege), \"empfehlung\": 1-2 Saetze was als Naechstes zu tun ist}.",
].join("\n");

// Volltext fuer die Suche: nur abschreiben, nichts deuten
const TEXT_PROMPT = [
  "Schreibe den vollstaendigen sichtbaren Text dieser Dokumentseiten ab - er dient der Volltextsuche. Nur abschreiben: nichts deuten, nichts uebersetzen, nichts ergaenzen, nichts weglassen.",
  "- Vor jeder Seite eine eigene Zeile '--- Seite N ---' (N = Seitennummer; bei beschrifteten Bildern die Nummer aus der Beschriftung).",
  "- Ist eine Seite in mehrere Streifen geteilt, ueberlappen sich die Streifen leicht: Zeilen im Ueberlappungsbereich nur EINMAL abschreiben, nichts doppelt.",
  "- Lesereihenfolge wie ein Mensch: mehrspaltige Bereiche Spalte fuer Spalte (links vor rechts, jeweils von oben nach unten). Briefkopf, Absender, Fusszeile, Randnotizen und Stempel jeweils als eigene Zeilen.",
  "- Tabellen: eine Tabellenzeile pro Textzeile, Zellen durch ' | ' getrennt, Kopfzeile zuerst; leere Zellen leer lassen.",
  "- Am Zeilenende getrennte Woerter zusammenfuegen (\"Kuendi-\" + \"gungsfrist\" -> \"Kuendigungsfrist\"), echte Bindestriche behalten.",
  "- Handschrift ebenfalls abschreiben; unsichere Woerter mit [?] dahinter, Unleserliches als [...].",
  "- Zahlen, Betraege, Daten, IBAN, Kunden-, Vertrags- und Rechnungsnummern Zeichen fuer Zeichen genau. Text in jeder Sprache so, wie er dasteht.",
  "- Ankreuzfelder als [x] bzw. [ ]. Logos und Bilder nur, wenn sie Text enthalten (dann den Text).",
  "- Ausgabe nur der Text: kein Markdown, keine Einleitung, keine Kommentare, keine Zusammenfassung.",
].join("\n");

// Sprachvorgabe: nur Freitexte uebersetzen. Die Schluesselwerte sind feste Codes,
// die der Client zum Einsortieren braucht - sie duerfen NIE uebersetzt werden.
function langHinweis(lang: string): string {
  if (lang !== "ru") return "";
  return [
    ``,
    `WICHTIG - SPRACHE: Schreibe NUR diese Freitextfelder auf RUSSISCH:`,
    `"titel", "zusammenfassung", "wichtig" (alle Eintraege), "hinweise", "behandlung".`,
    ``,
    `ALLES ANDERE bleibt unveraendert:`,
    `- "docType", "kategorie", "fachrichtung", "medTyp" sind feste Codes und MUESSEN exakt die oben`,
    `  genannten deutschen Kleinbuchstaben-Werte behalten (z. B. "rechnung", "strom", "zahnarzt").`,
    `- Eigennamen ("anbieter", "produkt", "arzt", "vertragspartner") NICHT uebersetzen.`,
    `- Nummern, Datumsangaben, Betraege, "details"-Schluessel und deren Werte bleiben wie sie sind.`,
    `- Deutsche Fachbegriffe im Freitext uebersetzen UND den deutschen Begriff in Klammern dahinter`,
    `  setzen, z. B. "Право на досрочное расторжение (Sonderkuendigungsrecht)".`,
  ].join("\n");
}

const PROMPT = [
  `Du bist der praezise Lese-Assistent eines deutschen Privathaushalts (\"Dokumenten-Butler\").`,
  `Das angehaengte Dokument ist ein privates Haushaltsdokument (Vertrag, Rechnung, Police, Tarifbestaetigung, Kuendigung, Preiserhoehung, E-Mail, Fahrzeugschein) ODER ein MEDIZINISCHES Dokument (Arztrechnung, Befund, Rezept, Attest, Laborwerte, Ueberweisung, Impfung, Roentgen, Arztbrief, Klinik/Apotheke/Physio) oder ein sonstiges Anschreiben.`,
  ``,
  `Gib AUSSCHLIESSLICH ein JSON-Objekt zurueck (kein Markdown) mit genau diesen Schluesseln:`,
  `- \"titel\": kurzer sprechender Titel fuer die Dokumentenliste (max. 60 Zeichen), Muster: Anbieter/Arzt + Dokumentart + Zeitraum/Jahr. Beispiele: \"AXA Kfz-Beitragsrechnung 2026\", \"NEW Gas SEPA-Mandat\", \"Fahrzeugschein VW Golf FB-SK 1990\", \"Hautarzt Dr. Meier Befund 06/2026\". IMMER setzen.`,
  `- \"docType\": \"vertrag\"|\"rechnung\"|\"police\"|\"kuendigung\"|\"preisaenderung\"|\"schreiben\"|\"fahrzeugschein\"|\"sonstiges\". \"fahrzeugschein\" = Zulassungsbescheinigung Teil I oder Teil II (Fahrzeugbrief).`,
  `- \"kategorie\": \"mobilfunk\",\"internet\",\"strom\",\"gas\",\"wasser\",\"versicherung\",\"streaming\",\"bank\",\"kfz\",\"wohnen\",\"gesundheit\",\"mitgliedschaft\",\"sonstiges\". KFZ-Versicherungen und Fahrzeugscheine: \"kfz\".`,
  `- \"anbieter\": Name des Anbieters/Versicherers/Unternehmens (string|null). Nimm den offiziellen Firmennamen; bei Marken den Markennamen (z. B. \"naturstrom\"). Beim Fahrzeugschein null (die Zulassungsstelle ist kein Anbieter).`,
  `- \"vertragspartner\": Vor- und Nachname der PRIVATPERSON (Vertragsinhaber/Versicherungsnehmer/Halter/Rechnungsempfaenger/Patient/Adressat), NICHT der Anbieter/Arzt. string|null.`,
  `- \"produkt\": Tarif-/Produkt-/Policenname (string|null).`,
  `- \"kundennummer\": Kunden-/Patientennummer (string|null).`,
  `- \"vertragsnummer\": Vertrags-/Policen-/Versicherungsscheinnummer oder Rechnungsnummer (string|null).`,
  `- \"datum\": Dokumentdatum ISO YYYY-MM-DD|null.`,
  `- \"vertragsstart\": Vertragsbeginn/Lieferbeginn/Versicherungsbeginn ISO|null.`,
  `- \"mindestlaufzeitMonate\": Zahl (0 = keine; null unbekannt).`,
  `- \"kuendigungsfristMonate\": Zahl, Wochen als Dezimal (2 Wochen=0.5, 6 Wochen=1.5). null unbekannt.`,
  `- \"verlaengerungMonate\": Zahl (1 = monatlich; null unbekannt).`,
  `- \"kosten\": die regelmaessig faellige Zahlung in EURO brutto pro Intervall als Zahl. Bei Strom/Gas/Wasser ist das der MONATLICHE ABSCHLAG. null wenn nicht vorhanden.`,
  `- \"kostenIntervall\": \"monatlich\"|\"vierteljaehrlich\"|\"halbjaehrlich\"|\"jaehrlich\"|\"einmalig\"|null.`,
  `- \"betrag\": bei Rechnungen der Rechnungsbetrag in EURO brutto als Zahl, sonst null.`,
  `- \"zeitraumVon\"/\"zeitraumBis\": bei Rechnungen Leistungszeitraum ISO|null.`,
  `- \"details\": Objekt mit KATEGORIE-SPEZIFISCHEN Zusatzangaben, NUR im Dokument vorhandene Schluessel (leer {} sonst). Erlaubte Schluessel:`,
  `  * versicherung: \"versichertesObjekt\",\"deckungsart\",\"deckungssumme\"(EUR),\"selbstbeteiligung\"(EUR),\"schadenfreiheitsklasse\"(z. B. \"SF 16\"),\"sfProzent\"(Zahl).`,
  `  * kfz (Versicherung UND Fahrzeugschein): \"kennzeichen\"(amtliches Kennzeichen wie gedruckt, z. B. \"FB-SK 1990\"; Feld A),\"marke\"(Hersteller, z. B. \"Volkswagen\"; Feld D.1),\"modell\"(Handelsbezeichnung, z. B. \"Golf\"; Feld D.3),\"fin\"(Fahrzeug-Identifizierungsnummer, 17 Zeichen ohne Leerzeichen; Feld E),\"hsn\"(Herstellerschluessel, 4 Ziffern; Feld 2.1 bzw. \"zu 2\"),\"tsn\"(Typschluessel, die ersten 3 Zeichen aus Feld 2.2),\"erstzulassung\"(ISO; Feld B),\"huBis\"(naechste Hauptuntersuchung ISO, nur wenn angegeben),\"deckungsart\"(Haftpflicht/Teilkasko/Vollkasko inkl. SB),\"schadenfreiheitsklasse\",\"sfProzent\"(Zahl),\"selbstbeteiligung\"(EUR). WICHTIG: Kennzeichen, Marke/Modell und Schluesselnummern stehen meist im Dokument - suche sie sorgfaeltig, auch im Kleingedruckten der Police.`,
  `  * mobilfunk: \"rufnummer\",\"datenvolumen\",\"endgeraet\".`,
  `  * internet: \"geschwindigkeit\",\"router\".`,
  `  * strom/gas: \"zaehlernummer\",\"jahresverbrauch\"(kWh Zahl),\"arbeitspreis\"(ct/kWh Zahl),\"grundpreis\"(EUR pro Monat Zahl). Den monatlichen Abschlag NICHT hier, sondern in \"kosten\".`,
  `  * wasser: \"zaehlernummer\".`,
  `  * streaming: \"aboStufe\",\"profile\". bank: \"kontoart\",\"zinssatz\"(Zahl),\"iban\". wohnen: \"objekt\",\"flaeche\"(m2 Zahl),\"nebenkosten\"(EUR Zahl). mitgliedschaft: \"leistungsumfang\",\"mitgliedsnummer\".`,
  `- \"istMedizin\": true bei medizinischem Dokument, sonst false.`,
  `- \"fachrichtung\": bei Medizin Kleinbuchstaben-Schluessel aus hausarzt/zahnarzt/kieferorthopaede/augenarzt/orthopaede/hautarzt/hno/frauenarzt/urologe/neurologe/kardiologe/radiologe/kinderarzt/psychotherapie/physiotherapie/apotheke/labor/krankenhaus/sonstiges. sonst null.`,
  `- \"arzt\": Name Arzt/Praxis/Klinik/Apotheke (string)|null.`,
  `- \"medTyp\": rechnung/befund/rezept/attest/laborwerte/ueberweisung/impfung/roentgen/arztbrief/sonstiges|null.`,
  `- \"behandlung\": kurze sachliche Angabe (1 Satz)|null.`,
  `- \"zusammenfassung\": 2-3 Saetze.`,
  `- \"wichtig\": Array kurzer Stichpunkte (Preiserhoehung, Sonderkuendigungsrecht, Frist, Erstattung, Folgetermin, HU faellig ...). Leeres Array wenn nichts.`,
  `- \"hinweise\": kurzer Hinweis (1-2 Saetze) zu Annahmen/Unsicherheiten; leer \"\" wenn eindeutig.`,
  ``,
  `Regeln: Geldbetraege BRUTTO in EURO, ct/100, Punkt als Dezimaltrennzeichen, keine Tausenderpunkte/Einheiten im Wert. \"1.234,56 EUR\"=1234.56. Medizin: kategorie=gesundheit, istMedizin=true. Unbekannt: null, nicht raten. Preisaenderung: neuer Preis in kosten, alter Preis als wichtig-Stichpunkt, Sonderkuendigungsrecht immer erwaehnen. E-Mail: Absender-Firma=anbieter, Angeschriebener=vertragspartner.`,
].join("\n");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "Der KI-Schluessel ist noch nicht hinterlegt." }, 500);
  let p: { fileBase64?: string; mimeType?: string; textContent?: string; bilder?: { data?: string; mime?: string }[]; dateien?: { data?: string; mime?: string }[]; modus?: string; streifen?: number[]; ab?: number; model?: string; level?: string; lang?: string; household_id?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }
  const chk = await pruefeAufruf(req, p.household_id);
  if ("antwort" in chk) return chk.antwort;
  const { fileBase64, mimeType, textContent } = p;
  // dateien: PDF und Bilder gemischt (Nebenkosten), bilder: nur Seitenbilder eines Scans
  const bilder = Array.isArray(p.dateien) ? p.dateien : (Array.isArray(p.bilder) ? p.bilder : null);
  const mitPdf = Array.isArray(p.dateien);
  if (!fileBase64 && !textContent && !(bilder && bilder.length)) return json({ error: "Keine Datei empfangen." }, 400);
  const st = stufe(p.level || p.model);
  const lv = level(st, { basic: 4000, advanced: 8000, max: 10000 });
  const lang = (p.lang === "ru") ? "ru" : "de";
  let docBlock: Record<string, unknown>;
  const bloecke: Record<string, unknown>[] = [];
  if (bilder && bilder.length) {
    // Seiten eines Scans: je Seite ein Bild, zusammen hoechstens so gross wie eine Datei
    if (bilder.length > MAX_BILDER) return json({ error: "Zu viele Seiten auf einmal (max. 20)." }, 413);
    let summe = 0;
    for (const b of bilder) {
      const mt = String(b?.mime || "image/jpeg");
      if (typeof b?.data !== "string" || !b.data) return json({ error: "Seite ohne Inhalt." }, 400);
      if (!(mitPdf ? ALLOWED_MIME : BILD_MIME).has(mt)) return json({ error: "Dateityp wird nicht unterstuetzt (nur PDF und Fotos)." }, 415);
      summe += b.data.length;
      if (summe > MAX_BASE64_LEN) return json({ error: "Datei zu gross fuer die Analyse (max. ca. 14 MB)." }, 413);
      bloecke.push(mt === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b.data } }
        : { type: "image", source: { type: "base64", media_type: mt, data: b.data } });
    }
    if (bloecke.length > 1) bloecke.push({ type: "text", text: mitPdf
      ? "Die " + bloecke.length + " Dateien oben gehoeren zu EINEM Vorgang (z. B. Nebenkosten- und Heizkostenabrechnung)."
      : "Die Bilder oben sind die " + bloecke.length + " Seiten EINES Dokuments, in dieser Reihenfolge." });
    docBlock = bloecke.shift() as Record<string, unknown>;
  } else if (textContent) {
    docBlock = { type: "text", text: "--- BEGINN DOKUMENT ---\n" + String(textContent).slice(0, 60000) + "\n--- ENDE DOKUMENT ---" };
  } else {
    if (typeof fileBase64 !== "string" || fileBase64.length > MAX_BASE64_LEN) return json({ error: "Datei zu gross fuer die Analyse (max. ca. 14 MB)." }, 413);
    const mt = mimeType || "application/pdf";
    if (!ALLOWED_MIME.has(mt)) return json({ error: "Dateityp wird nicht unterstuetzt (nur PDF und Fotos)." }, 415);
    docBlock = mt === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
      : { type: "image", source: { type: "base64", media_type: mt, data: fileBase64 } };
  }
  // Modus "text": Volltext abschreiben (fuer die Suche) - immer das guenstigste Modell
  if (p.modus === "text") {
    const lvT = level("basic", { basic: 16000, advanced: 16000, max: 16000 });
    let inhaltT: Record<string, unknown>[] = [docBlock, ...bloecke];
    // Streifen je Seite: jedes Bild beschriften ("Seite 3 - Streifen 2 von 4"), Hinweissatz der Seiten weglassen
    const streifen = Array.isArray(p.streifen) ? p.streifen.map((n: unknown) => Math.floor(Number(n))) : null;
    if (streifen && bilder && bilder.length) {
      const summe = streifen.reduce((a: number, b: number) => a + b, 0);
      if (summe !== bilder.length || streifen.some((n: number) => !(n >= 1 && n <= 4))) return json({ error: "Streifen passen nicht zu den Bildern." }, 400);
      const ab = Math.max(1, Math.min(9999, Math.floor(Number(p.ab) || 1)));
      const bildBloecke = [docBlock, ...bloecke].filter((b) => b.type === "image");
      inhaltT = [];
      let k = 0;
      streifen.forEach((n: number, si: number) => {
        for (let j = 0; j < n; j++) {
          inhaltT.push({ type: "text", text: "Seite " + (ab + si) + (n > 1 ? " - Streifen " + (j + 1) + " von " + n + " (von oben nach unten)" : "") + ":" });
          inhaltT.push(bildBloecke[k++]);
        }
      });
    }
    const bodyT = { messages: [{ role: "user", content: [...inhaltT, { type: "text", text: TEXT_PROMPT }] }] };
    let rt;
    try { rt = await claude(lvT, bodyT); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
    if (!rt.resp.ok) return await claudeFehler(rt.resp, "Texterkennung");
    const dt = await rt.resp.json();
    if (dt.stop_reason === "refusal") return json({ error: "Die KI hat dieses Dokument nicht ausgewertet." }, 422);
    const text = antwortText(dt).trim();
    const modellT = String(dt.model || rt.lv.model);
    const kostenT = await protokoll(chk.wer, "allhome-text", "basic", modellT, dt.usage, !!text);
    return json({ text, modell: modellT, stufe: "basic", kosten_usd: kostenT });
  }
  // Modi "nk" und "nk-bewertung": Nebenkosten auslesen bzw. ueber alle Jahre einordnen
  if (p.modus === "nk" || p.modus === "nk-bewertung") {
    const bew = p.modus === "nk-bewertung";
    if (bew && !textContent) return json({ error: "Keine Daten fuer die Einschaetzung." }, 400);
    const lvN = level(st, bew ? { basic: 2500, advanced: 4000, max: 5000 } : { basic: 8000, advanced: 12000, max: 16000 });
    const sprache = lang === "ru"
      ? "\nSchreibe alle Freitexte (kurz, titel, text, empfehlung, hinweise) auf RUSSISCH; deutsche Fachbegriffe in Klammern dahinter. Codes und Zahlen bleiben."
      : "";
    const bodyN = { messages: [{ role: "user", content: [docBlock, ...bloecke, { type: "text", text: (bew ? NK_BEWERTUNG : NK_PROMPT) + sprache }] }] };
    let rn;
    try { rn = await claude(lvN, bodyN); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
    if (!rn.resp.ok) return await claudeFehler(rn.resp, bew ? "Einschaetzung" : "Auswertung");
    const dn = await rn.resp.json();
    if (dn.stop_reason === "refusal") return json({ error: "Die KI hat dieses Dokument nicht ausgewertet." }, 422);
    const ergebnis = repairJson(antwortText(dn));
    const modellN = String(dn.model || rn.lv.model);
    const kostenN = await protokoll(chk.wer, bew ? "allhome-nk-bewertung" : "allhome-nk", st, modellN, dn.usage, !!ergebnis);
    if (!ergebnis) return json({ error: "Antwort konnte nicht gelesen werden." }, 500);
    return json({ [bew ? "einschaetzung" : "abrechnung"]: ergebnis, modell: modellN, stufe: st, lang, kosten_usd: kostenN });
  }
  const body = { messages: [{ role: "user", content: [docBlock, ...bloecke, { type: "text", text: PROMPT + langHinweis(lang) }] }] };
  let r;
  try { r = await claude(lv, body); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
  if (!r.resp.ok) return await claudeFehler(r.resp, "Auswertung");
  const data = await r.resp.json();
  if (data.stop_reason === "refusal") return json({ error: "Die KI hat dieses Dokument nicht ausgewertet." }, 422);
  const parsed = repairJson(antwortText(data));
  const modell = String(data.model || r.lv.model);
  const kosten = await protokoll(chk.wer, "allhome-extract", st, modell, data.usage, !!parsed);
  if (!parsed) return json({ error: "Antwort konnte nicht gelesen werden." }, 500);
  return json({ dokument: parsed, modell, stufe: st, lang, usage: { input: data.usage?.input_tokens ?? null, output: data.usage?.output_tokens ?? null }, kosten_usd: kosten });
});
