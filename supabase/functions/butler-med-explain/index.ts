// Supabase Edge Function: butler-med-explain
// Erklaert ein medizinisches Dokument (v. a. Arztrechnungen) fuer Laien, mit Websuche zu
// GOAe/GOZ-Ziffern, Diagnosen und Materialien.
// v8: nur angemeldete Nutzer, Tageslimit/Budget, Kosten in public.ai_calls.
// Gemeinsamer Kern (Anmeldung, Limits, Kosten-Protokoll, Claude-Aufruf): gemeinsam.ts

import { ANTHROPIC_API_KEY, antwortText, claude, claudeFehler, cors, json, level, protokoll, pruefeAufruf, repairJson, stufe } from "./gemeinsam.ts";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64_LEN = 20_000_000;

// Sprachvorgabe: recherchiert wird weiter in deutschen Quellen, erklaert wird in der Zielsprache.
function langHinweis(lang: string): string {
  if (lang !== "ru") return "";
  return [
    ``,
    `WICHTIG - SPRACHE: Recherchiere weiterhin in deutschen Quellen (GOAe/GOZ), aber schreibe ALLE Freitexte`,
    `("erklaerung", "leistungen[].position", "leistungen[].erklaerung", "materialien[].material",`,
    `"materialien[].erklaerung", "begriffe[].begriff", "begriffe[].erklaerung", "auffaellig", "erstattung", "hinweise")`,
    `auf RUSSISCH - in einfacher, freundlicher Alltagssprache.`,
    `Eigennamen (Praxen, Aerzte, Produktnamen) NICHT uebersetzen.`,
    `Abrechnungsziffern (GOAe/GOZ-Nummern), Betraege und Datumsangaben bleiben unveraendert.`,
    `Deutsche Fachbegriffe uebersetzen UND den deutschen Begriff in Klammern dahinter setzen,`,
    `z. B. "Возмещение (Erstattung)". "quellen" behaelt die Original-Titel der Webseiten.`,
  ].join("\n");
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "Der KI-Schluessel ist noch nicht hinterlegt." }, 500);
  let p: { fileBase64?: string; mimeType?: string; kontext?: Record<string, unknown>; model?: string; level?: string; lang?: string; household_id?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }
  const chk = await pruefeAufruf(req, p.household_id);
  if ("antwort" in chk) return chk.antwort;
  const { fileBase64, mimeType } = p;
  if (typeof fileBase64 !== "string" || !fileBase64) return json({ error: "Keine Datei empfangen." }, 400);
  if (fileBase64.length > MAX_BASE64_LEN) return json({ error: "Datei zu gross fuer die Analyse (max. ca. 14 MB)." }, 413);
  const mt = mimeType || "application/pdf";
  if (!ALLOWED_MIME.has(mt)) return json({ error: "Dateityp wird nicht unterstuetzt (nur PDF und Fotos)." }, 415);
  const docBlock = mt === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
    : { type: "image", source: { type: "base64", media_type: mt, data: fileBase64 } };
  const st = stufe(p.level || p.model);
  const lv = level(st, { basic: 3500, advanced: 8000, max: 10000 });
  const lang = (p.lang === "ru") ? "ru" : "de";
  const k = p.kontext || {};

  const frage = [
    `Du bist der Gesundheits-Assistent eines deutschen Privathaushalts (\"Dokumenten-Butler\").`,
    `Das angehaengte Dokument ist ein medizinisches Dokument (z. B. Arztrechnung, Befund, Laborwerte, Arztbrief, Rezept).`,
    k.arzt ? `Kontext: Arzt/Praxis: ${String(k.arzt).slice(0, 120)}` : ``,
    k.fachrichtung ? `Fachrichtung: ${String(k.fachrichtung).slice(0, 60)}` : ``,
    k.medTyp ? `Dokumentart: ${String(k.medTyp).slice(0, 40)}` : ``,
    k.betrag != null ? `Rechnungsbetrag: ${k.betrag} EUR` : ``,
    ``,
    `Deine Aufgabe: Erklaere einem medizinischen Laien GUT VERSTAENDLICH, was in diesem Dokument steht.`,
    `1. Lies das Dokument genau (bei Rechnungen: jede Abrechnungsposition, GOAe-/GOZ-Ziffern, Steigerungsfaktoren, Auslagen/Materialien).`,
    `2. Recherchiere im Internet, was die abgerechneten Ziffern/Leistungen bedeuten (offizielle GOAe/GOZ-Verzeichnisse, serioese Quellen) und was Diagnosen/Fachbegriffe/Abkuerzungen bedeuten (ICD-Codes, Laborwerte, Medikamente).`,
    `3. Achte auf VERWENDETE MATERIALIEN und Auslagen (z. B. Fuellungsmaterial/Komposit, Abformmaterial, Implantate, Verbandmaterial, Kontrastmittel, Einmalinstrumente, Laborkosten) - recherchiere bei Bedarf, was das Material ist und wofuer es eingesetzt wird.`,
    `4. Pruefe grob auf Auffaelligkeiten: ungewoehnlich hohe Steigerungsfaktoren (ueber 2,3 ohne Begruendung, ueber 3,5 generell), doppelte Positionen, unplausible Betraege.`,
    ``,
    `Gib nach der Recherche AUSSCHLIESSLICH ein JSON-Objekt zurueck (kein Markdown) mit genau diesen Schluesseln:`,
    `- \"erklaerung\": 3-6 Saetze in einfacher Alltagssprache: Worum geht es, was wurde gemacht/abgerechnet, was bedeutet das fuer den Patienten. Keine Fachbegriffe ohne Erklaerung.`,
    `- \"leistungen\": Array von {\"position\":string (Ziffer/Bezeichnung wie im Dokument, ggf. mit Betrag),\"erklaerung\":string (1-2 einfache Saetze, was diese Leistung ist und wofuer sie gemacht wird)}. Bei Rechnungen ALLE Positionen. Leer wenn keine Abrechnungspositionen.`,
    `- \"materialien\": Array von {\"material\":string (Bezeichnung wie im Dokument, ggf. mit Betrag),\"erklaerung\":string (1-2 einfache Saetze: was ist das Material, wofuer wurde es verwendet)}. NUR Materialien/Auslagen, die im Dokument erkennbar sind - nichts vermuten. Leeres Array wenn keine erkennbar.`,
    `- \"begriffe\": Array von {\"begriff\":string,\"erklaerung\":string} - Diagnosen, Symptome, Fachbegriffe, Abkuerzungen, Laborwerte aus dem Dokument, jeweils laienverstaendlich erklaert (inkl. was ein auffaelliger Wert bedeuten kann). Leer wenn keine.`,
    `- \"auffaellig\": Array kurzer Stichpunkte mit Auffaelligkeiten (hoher Steigerungsfaktor, moegliche Doppelabrechnung, fehlende Begruendung, ungewoehnlicher Betrag). Leeres Array wenn alles ueblich aussieht.`,
    `- \"erstattung\": 1-3 Saetze: Hinweise zur Erstattung (PKV/Beihilfe/GKV-Selbstzahler, Einreichung, Fristen) passend zum Dokument; leer \"\" wenn nicht relevant.`,
    `- \"quellen\": Array von {\"titel\":string,\"url\":string} (max. 5, nur tatsaechlich genutzte serioese Quellen).`,
    `- \"hinweise\": kurzer Hinweis zu Unsicherheiten (z. B. schlecht lesbare Stellen); leer \"\" wenn keiner.`,
    ``,
    `Regeln: Einfache, freundliche Sprache (\"Blutabnahme\" statt \"Venenpunktion\", erklaere die Fachworte in Klammern). Keine Diagnosen stellen, keine Therapieempfehlungen - nur erklaeren, was da steht. Unleserliches ehrlich benennen, nichts erfinden. Geldbetraege in EURO.`,
    langHinweis(lang),
  ].filter(Boolean).join("\n");

  const body = { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }], messages: [{ role: "user", content: [docBlock, { type: "text", text: frage }] }] };
  let r;
  try { r = await claude(lv, body); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
  if (!r.resp.ok) return await claudeFehler(r.resp, "Erklaerung");
  const data = await r.resp.json();
  if (data.stop_reason === "refusal") return json({ error: "Die KI hat dieses Dokument nicht ausgewertet." }, 422);
  const parsed = repairJson(antwortText(data));
  const modell = String(data.model || r.lv.model);
  const kosten = await protokoll(chk.wer, "allhome-med", st, modell, data.usage, !!parsed);
  if (!parsed) return json({ error: "Antwort konnte nicht gelesen werden." }, 500);
  return json({ recherche: parsed, modell, stufe: st, lang, kosten_usd: kosten });
});
