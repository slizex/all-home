// Supabase Edge Function: butler-nk-analyse (v1, All-Home 1.11.0) – getestet mit fiktiven Daten (Opus mittel ~70 s / 0,23 $, Sonnet ~45 s / 0,10 $)
// Nebenkosten-Analyse eines Haushalts ueber alle Jahre: Bericht (strukturiertes JSON) und Rueckfragen
// (mit Zitaten aus den Dokumenten, auf Wunsch mit Internet-Recherche).
// Die App rechnet alle Zahlen selbst (FAKTEN) und schickt den abgeschriebenen Text der Abrechnungen
// (DOKUMENTE), das Gedaechtnis des Haushalts und den vorigen Bericht mit. Die KI deutet, belegt und empfiehlt.
// Modelle: "gruendlich" = Opus 5.5, "schnell" = Sonnet 5.5. Refusal-Fallback serverseitig ("default").
// Gemeinsamer Kern (Anmeldung, Limits, Kosten-Protokoll): gemeinsam.ts

import { ANTHROPIC_API_KEY, antwortText, cors, json, protokoll, pruefeAufruf, repairJson } from "./gemeinsam.ts";

type Qualitaet = "gruendlich" | "schnell";
const MODELL: Record<Qualitaet, string> = { gruendlich: "claude-opus-5-5", schnell: "claude-sonnet-5-5" };
const STUFE: Record<Qualitaet, "max" | "advanced"> = { gruendlich: "max", schnell: "advanced" };
const MAX_FAKTEN = 300_000;     // Zeichen
const MAX_TEXTE = 220_000;      // Zeichen aller Dokumenttexte zusammen
const MAX_TEXT = 60_000;        // je Dokument
const GROSS = 120_000;          // ab so vielen Zeichen (Fakten + Texte) denkt "gruendlich" knapper (Laufzeitgrenze 150 s)

const SYSTEM = [
  "Du bist der Nebenkosten-Analyst von All-Home, einer privaten Haushalts-App in Deutschland. Du analysierst die Betriebskosten- bzw. Nebenkostenabrechnungen EINES Haushalts ueber alle vorhandenen Jahre - sachlich und praezise wie ein erfahrener Mieterberater, bei Eigentuemern wie ein Haushaltsberater.",
  "",
  "Arbeitsweise:",
  "1. Grundlagen: FAKTEN (von der App exakt berechnet: Summen, Kategorien, Positionen je Jahr, EUR je m2 und Monat, Veraenderungen, Vergleich mit dem Betriebskostenspiegel, Pruefhinweise der App, Fristen), DOKUMENTE (abgeschriebener Text der Originalabrechnungen), GEDAECHTNIS (was der Haushalt frueher festgehalten hat) und ggf. der VORIGE BERICHT.",
  "2. Zahlen: Nimm Betraege aus den FAKTEN. Rechne nicht nach, was dort schon steht. Wenn du selbst rechnest, runde auf volle Euro und schreibe \"rund\". Erfinde keine Zahlen, Daten, Urteile, Paragrafen oder Fristen.",
  "3. Belege: Stuetze Pruefpunkte und Kostentreiber auf woertliche Textstellen aus den DOKUMENTEN (exakt wie im Text, hoechstens 200 Zeichen, ohne Auslassungen) und nenne den Dokumenttitel. Gibt es keine passende Textstelle, lass den Beleg leer und stufe die Sicherheit hoechstens als \"pruefen\" ein.",
  "4. Sicherheit beschreibt, wie sicher der Fehler bzw. Anspruch ist - nicht, ob er wegen einer Frist noch durchsetzbar ist (das gehoert in Text und Aktion): \"sicher\" nur bei eindeutiger Rechtslage UND Beleg, \"wahrscheinlich\" bei starkem Indiz, sonst \"pruefen\".",
  "5. Relevanz: Nur was fuer DIESEN Haushalt zaehlt, keine allgemeinen Ratschlaege ohne Bezug. Bewerte die Pruefhinweise der App, statt sie zu wiederholen.",
  "6. Mieter oder Eigentuemer: FAKTEN.haushalt.art sagt, was die App vermutet. Bei Eigentuemern (z. B. nur Muell-, Grundsteuer- und Schornsteinfegerbescheide, keine Vorauszahlungen) keine Einwaende gegen Vermieter, sondern: Bescheide pruefen, Gebuehren und Leistungen vergleichen, Sparmoeglichkeiten (z. B. Tonnengroesse, Abholrhythmus), Steuerermaessigung nach Paragraf 35a EStG.",
  "7. Fristen: Die App berechnet sie exakt (z. B. Einwaende bis zum Ablauf des zwoelften Monats nach Zugang = Monatsende). Uebernimm diese Daten unveraendert, rechne sie nicht neu und nenne keine Fristen ohne Grundlage in FAKTEN oder DOKUMENTEN.",
  "8. Stil: klar, kurz, konkret, ohne Floskeln; Pruefpunkt-Texte hoechstens 3 Saetze. Keine Rechtsberatung - bei Streitfragen auf Belegeinsicht und Mieterverein verweisen.",
  "",
  "Rechtsstand Oktober 2026 (nur verwenden, wenn es passt):",
  "- Paragraf 556 Abs. 3 BGB: Abrechnung spaetestens 12 Monate nach Ende des Abrechnungszeitraums, danach keine Nachforderung (ausser der Vermieter hat die Verspaetung nicht zu vertreten, z. B. spaeter Grundsteuerbescheid; nach Einspruch gegen den Grundsteuerbescheid laeuft die Frist fuer die Nachberechnung erst ab der Entscheidung). Einwendungen des Mieters bis 12 Monate nach Zugang. Abrechnungszeitraum hoechstens 12 Monate.",
  "- Belegeinsicht: Mieter duerfen die Originalbelege einschliesslich Zahlungsbelegen einsehen, ohne einen Verdacht begruenden zu muessen (BGH VIII ZR 118/19); bis dahin darf eine Nachzahlung zurueckbehalten werden.",
  "- Wirtschaftlichkeitsgebot: Fehlende Vergleichsangebote allein sind kein Verstoss; entscheidend sind objektiv ueberhoehte Preise, Einwaende muessen konkret sein (BGH 20.05.2026, VIII ZR 6/24).",
  "- Umlagefaehig ist nur, was im Mietvertrag vereinbart ist und in Paragraf 2 BetrKV steht. Nicht umlagefaehig: Verwaltung, Instandhaltung und Reparaturen, Ruecklagen, Bankgebuehren, Porto, Miete von Rauchwarnmeldern (deren Wartung schon). Neue Kostenarten brauchen eine vertragliche Grundlage.",
  "- Kabel-TV: Das Nebenkostenprivileg ist seit 1.7.2024 entfallen; TV-Gebuehren eines Sammelvertrags sind nicht mehr umlagefaehig. Betriebsstrom und Wartung einer Gemeinschaftsantenne bleiben umlagefaehig.",
  "- Glasfaser-Bereitstellungsentgelt (Paragraf 72 TKG): hoechstens 60 EUR je Jahr und Wohnung, hoechstens 5 (ausnahmsweise 9) Jahre, insgesamt hoechstens 540 EUR.",
  "- Heizkostenverordnung: 50 bis 70 Prozent nach Verbrauch, sonst Kuerzungsrecht 15 Prozent (Paragraf 12). Bei fernablesbaren Zaehlern seit 2022 monatliche Verbrauchsinformation Pflicht, sonst 3 Prozent Kuerzung des Heizkostenanteils. Nicht fernablesbare Geraete muessen bis 31.12.2026 ersetzt sein, sonst ab 2027 Kuerzung um 3 Prozent.",
  "- CO2-Kostenaufteilungsgesetz (seit 1.1.2023): Stufenmodell nach kg CO2 je m2 und Jahr (Mieteranteil in 10 Stufen von 100 bis 5 Prozent); Mieteranteil, Einstufung und Berechnungsgrundlagen muessen in der Heizkostenabrechnung stehen, sonst darf der Mieter seinen Anteil an den Heizkosten um 3 Prozent kuerzen (Paragraf 7 Abs. 4 CO2KostAufG). Ab 2028 werden CO2-Kosten und bei Gas die Netzentgelte haelftig geteilt (Gebaeudemodernisierungsgesetz, in Kraft seit 29.7.2026).",
  "- Grundsteuer: seit 2025 nach neuer Bewertung (Reform); Erhoehungen sind zulaessig, aber Bescheid, Jahr, Verteilerschluessel und Leerstand pruefen, Einsicht in den Bescheid verlangen.",
  "- Paragraf 35a EStG: 20 Prozent der Arbeitskosten fuer haushaltsnahe Dienstleistungen (Ermaessigung hoechstens 4.000 EUR je Jahr) und Handwerkerleistungen (hoechstens 1.200 EUR je Jahr), auch fuer Mieter ueber die Nebenkostenabrechnung.",
  "- Betriebskostenspiegel des Deutschen Mieterbunds (Abrechnungsjahr 2024, veroeffentlicht 12/2025): im Schnitt 2,67 EUR je m2 und Monat, bis 3,68 EUR wenn alle Kostenarten anfallen, Heizung und Warmwasser im Schnitt 1,32 EUR. Werte je Kategorie stehen in den FAKTEN.",
].join("\n");

const BERICHT_AUFGABE = [
  "AUFGABE: Erstelle den Bericht als JSON nach dem vorgegebenen Schema.",
  "- ampel: gruen = unauffaellig, gelb = einzelne Punkte pruefen, rot = wahrscheinlich zu viel berechnet oder Frist laeuft.",
  "- kurzfazit: 3-4 Saetze mit dem Wichtigsten (Entwicklung, groesster Treiber, wichtigster Pruefpunkt mit Betrag, naechster Schritt).",
  "- art: mieter, eigentuemer oder unklar.",
  "- entwicklung.text: 2-4 Saetze zur Entwicklung der Gesamtkosten und je m2 im Vergleich zum Betriebskostenspiegel; hervorheben = Kategorie-Codes, die auffallen.",
  "- treiber: von/bis = zwei Zeitraum-Labels aus FAKTEN.jahre (moeglichst vergleichbar, meist das neueste und das Vorjahr); punkte = die wichtigsten Kategorien (Codes aus FAKTEN) mit Ursache laut Dokument.",
  "- pruefpunkte: hoechstens 8, nach Geldwert absteigend; betrag = moeglicher Betrag zugunsten des Haushalts in EUR (null, wenn nicht bezifferbar); jahr = Zeitraum-Label; kategorie = Code oder null; aktion = was konkret zu tun ist.",
  "- prognose: naechster Abrechnungszeitraum; kosten in EUR; vorauszahlung_monat nur bei Mietern (sonst null); nutze FAKTEN.prognose_basis und begruende Abweichungen.",
  "- todos: konkrete naechste Schritte, frist als ISO-Datum (YYYY-MM-DD) nur wenn ableitbar, wichtig = true fuer Fristen und Geld.",
  "- seit_letztem: nur wenn ein VORIGER BERICHT da ist (neu = neue Erkenntnisse, erledigt = Punkte, die sich erledigt haben, offen = weiterhin offen), sonst leere Listen.",
  "- gedaechtnis_neu: 0-5 dauerhafte, haushaltsspezifische Fakten aus den Dokumenten, die kuenftigen Analysen helfen (z. B. Vermieter oder Verwaltung, Messdienst, Verteilerschluessel, Besonderheiten der Wohnung). Keine Bewertungen, keine Betraege oder Werte, die sich jaehrlich aendern, nichts, was schon im GEDAECHTNIS steht.",
  "- hinweise: Unsicherheiten (fehlende Jahre oder Dokumente, schlecht lesbare Stellen), sonst leer.",
].join("\n");

const FRAGE_AUFGABE = [
  "AUFGABE: Beantworte die RUECKFRAGE des Haushalts zu seinen Nebenkosten.",
  "- Praezise und kurz (meist 3-10 Saetze, gern mit kurzen Aufzaehlungen). Stuetze dich auf FAKTEN, DOKUMENTE, GEDAECHTNIS und den BERICHT; zitiere Textstellen aus den Dokumenten.",
  "- Ist ein Musterschreiben gewuenscht (Belegeinsicht, Widerspruch, Anpassung der Vorauszahlung), schreibe es vollstaendig mit Platzhaltern wie [Name], [Adresse], [Datum] und konkreten Betraegen und Fristen aus den FAKTEN.",
  "- Bittet der Haushalt dich, dir etwas zu merken, oder erfaehrst du einen dauerhaften haushaltsspezifischen Fakt, schreibe am Ende je Fakt eine eigene Zeile \"MERKEN: ...\" (hoechstens 2).",
  "- Ohne Internet-Recherche nichts Aktuelles behaupten, was nicht im Rechtsstand oder in den Daten steht.",
  "- Format: reiner Text ohne Markdown (keine Sternchen, keine Rauten, keine Trennlinien). Absaetze durch Leerzeilen, Aufzaehlungen mit \"- \" am Zeilenanfang.",
].join("\n");

const RECHERCHE = "\nINTERNET-RECHERCHE ist eingeschaltet: Nutze die Websuche fuer alles Aktuelle oder Oertliche (z. B. Hebesaetze, Gebuehren, Preise, neue Urteile), bevorzuge amtliche Quellen und stuetze deine Aussagen auf die gefundenen Seiten.";

// Schema des Berichts (strukturierte Ausgabe)
const S = { type: "string" };
const SN = { anyOf: [{ type: "string" }, { type: "null" }] };
const NN = { anyOf: [{ type: "number" }, { type: "null" }] };
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const BERICHT_SCHEMA = obj({
  ampel: { type: "string", enum: ["gruen", "gelb", "rot"] },
  kurzfazit: S,
  art: { type: "string", enum: ["mieter", "eigentuemer", "unklar"] },
  entwicklung: obj({ text: S, hervorheben: { type: "array", items: S } }),
  treiber: obj({ von: S, bis: S, text: S, punkte: { type: "array", items: obj({ kategorie: S, ursache: S, beleg: SN, dokument: SN }) } }),
  pruefpunkte: { type: "array", items: obj({
    titel: S, text: S, betrag: NN, sicherheit: { type: "string", enum: ["sicher", "wahrscheinlich", "pruefen"] },
    jahr: SN, kategorie: SN, beleg: SN, dokument: SN, aktion: S,
  }) },
  prognose: obj({ zeitraum: S, kosten: NN, vorauszahlung_monat: NN, text: S }),
  todos: { type: "array", items: obj({ text: S, frist: SN, wichtig: { type: "boolean" } }) },
  seit_letztem: obj({ neu: { type: "array", items: S }, erledigt: { type: "array", items: S }, offen: { type: "array", items: S } }),
  gedaechtnis_neu: { type: "array", items: S },
  hinweise: S,
});

type Text = { titel: string; text: string };
function texteLesen(roh: unknown): Text[] {
  const out: Text[] = [];
  let summe = 0;
  for (const t of Array.isArray(roh) ? roh : []) {
    const titel = String((t as Text)?.titel || "Dokument").slice(0, 120);
    let text = String((t as Text)?.text || "").slice(0, MAX_TEXT);
    if (!text.trim()) continue;
    if (summe + text.length > MAX_TEXTE) text = text.slice(0, Math.max(0, MAX_TEXTE - summe));
    if (!text) break;
    summe += text.length;
    out.push({ titel, text });
  }
  return out;
}
// Text in zitierbare Zeilen (leere weg, sehr lange in Stuecke)
function zeilen(text: string): string[] {
  const out: string[] = [];
  for (const z of text.split(/\r?\n/)) {
    const x = z.trim();
    if (!x) continue;
    for (let i = 0; i < x.length; i += 500) out.push(x.slice(i, i + 500));
  }
  return out.length ? out : [text.slice(0, 500) || "-"];
}
function sprache(lang: string): string {
  return lang === "ru"
    ? "\nSPRACHE: Schreibe alle Texte auf RUSSISCH; deutsche Fachbegriffe in Klammern dahinter. Zitate aus den Dokumenten (beleg) bleiben im Original, Codes und Zahlen bleiben."
    : "\nSPRACHE: Deutsch.";
}

// Anfrage an Claude mit serverseitigem Refusal-Fallback; lehnt die API eine Zusatzfunktion ab, einmal ohne sie
async function senden(body: Record<string, unknown>, extras: { fallback: boolean }): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01" };
  const b: Record<string, unknown> = { ...body };
  if (extras.fallback) { headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; b.fallbacks = "default"; }
  return await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(b) });
}
async function claudeRobust(body: Record<string, unknown>, jsonHinweis: string): Promise<{ resp: Response; ohneFormat: boolean }> {
  let resp = await senden(body, { fallback: true });
  let ohneFormat = false;
  if (resp.status === 400) {
    const peek = await resp.clone().text();
    console.warn("butler-nk-analyse 400:", peek.slice(0, 400));
    const b2: Record<string, unknown> = { ...body };
    if (/output_config|format|schema/i.test(peek) && b2.output_config) {
      const oc = { ...(b2.output_config as Record<string, unknown>) };
      delete oc.format;
      b2.output_config = oc;
      ohneFormat = true;
      // Ohne Schema: JSON per Anweisung
      const msgs = b2.messages as { role: string; content: Record<string, unknown>[] }[];
      msgs[msgs.length - 1].content.push({ type: "text", text: jsonHinweis });
    }
    resp = await senden(b2, { fallback: !/fallback/i.test(peek) });
  }
  return { resp, ohneFormat };
}
// Fehler der KI in eine klare Meldung (Guthaben/Limit protokolliert gemeinsam.ts nicht hier – nur Meldung)
async function kiFehler(resp: Response): Promise<Response> {
  const detail = await resp.text();
  const d = detail.toLowerCase();
  if (resp.status === 402 || /credit balance|insufficient|billing|payment required|out of credits/.test(d))
    return json({ error: "Das KI-Guthaben ist aufgebraucht. Bitte spaeter erneut versuchen.", code: "ki_guthaben" }, 402);
  if (resp.status === 429) return json({ error: "KI-Limit erreicht (429). Bitte spaeter erneut versuchen.", code: "limit" }, 429);
  console.error("butler-nk-analyse:", resp.status, detail.slice(0, 600));
  return json({ error: "Analyse fehlgeschlagen (" + resp.status + ").", detail: detail.slice(0, 300) }, 502);
}
// Kosten wie abgerechnet: Cache-Schreiben 1,25-fach, Cache-Lesen 0,1-fach des Eingabepreises
function protokollUsage(u: Record<string, unknown> | undefined): Record<string, unknown> {
  const inp = Number(u?.input_tokens) || 0, cw = Number(u?.cache_creation_input_tokens) || 0, cr = Number(u?.cache_read_input_tokens) || 0;
  return { input_tokens: Math.round(inp + cw * 1.25 + cr * 0.1), output_tokens: Number(u?.output_tokens) || 0, server_tool_use: u?.server_tool_use };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "Der KI-Schluessel ist noch nicht hinterlegt." }, 500);
  let p: { modus?: string; qualitaet?: string; fakten?: unknown; texte?: unknown; gedaechtnis?: unknown; vorher?: unknown; bericht?: unknown;
    frage?: string; verlauf?: unknown; recherche?: boolean; lang?: string; household_id?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }
  const modus = p.modus === "frage" ? "frage" : "bericht";
  const chk = await pruefeAufruf(req, p.household_id, modus === "frage" ? "allhome-nk-frage" : "allhome-nk-analyse");
  if ("antwort" in chk) return chk.antwort;
  const q: Qualitaet = p.qualitaet === "schnell" ? "schnell" : "gruendlich";
  const lang = p.lang === "ru" ? "ru" : "de";
  const fakten = JSON.stringify(p.fakten ?? {});
  if (fakten.length < 20) return json({ error: "Keine Nebenkosten-Daten." }, 400);
  if (fakten.length > MAX_FAKTEN) return json({ error: "Zu viele Daten auf einmal." }, 413);
  const texte = texteLesen(p.texte);
  const gedaechtnis = (Array.isArray(p.gedaechtnis) ? p.gedaechtnis : []).slice(0, 60).map((g) => "- " + String(g).slice(0, 300)).join("\n");
  const kontext = [
    "FAKTEN (von der App berechnet, JSON):\n" + fakten,
    "GEDAECHTNIS des Haushalts:\n" + (gedaechtnis || "(leer)"),
  ];

  if (modus === "bericht") {
    const vorher = p.vorher ? JSON.stringify(p.vorher).slice(0, 30_000) : "";
    const dokumente = texte.length
      ? texte.map((t) => "=== DOKUMENT: " + t.titel + " ===\n" + t.text).join("\n\n")
      : "(Zu diesen Abrechnungen liegt kein abgeschriebener Text vor.)";
    const inhalt: Record<string, unknown>[] = [
      { type: "text", text: kontext.join("\n\n") },
      { type: "text", text: "DOKUMENTE:\n" + dokumente },
      { type: "text", text: vorher ? "VORIGER BERICHT (JSON):\n" + vorher : "VORIGER BERICHT: keiner." },
      { type: "text", text: BERICHT_AUFGABE + sprache(lang) },
    ];
    const body = {
      model: MODELL[q], max_tokens: 16000, system: SYSTEM,
      output_config: { effort: fakten.length + texte.reduce((n, t) => n + t.text.length, 0) > GROSS ? "low" : "medium", format: { type: "json_schema", schema: BERICHT_SCHEMA } },
      messages: [{ role: "user", content: inhalt }],
    };
    let r;
    try { r = await claudeRobust(body, "Gib AUSSCHLIESSLICH ein JSON-Objekt mit den Schluesseln ampel, kurzfazit, art, entwicklung, treiber, pruefpunkte, prognose, todos, seit_letztem, gedaechtnis_neu, hinweise zurueck (kein Markdown)."); }
    catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
    if (!r.resp.ok) return await kiFehler(r.resp);
    const data = await r.resp.json();
    if (data.stop_reason === "refusal") return json({ error: "Die KI hat die Analyse abgelehnt.", code: "abgelehnt" }, 422);
    const roh = antwortText(data);
    let bericht: Record<string, unknown> | null = null;
    try { bericht = JSON.parse(roh); } catch (_) { bericht = repairJson(roh); }
    const modell = String(data.model || MODELL[q]);
    const kosten = await protokoll(chk.wer, "allhome-nk-analyse", STUFE[q], MODELL[q], protokollUsage(data.usage), !!bericht);
    if (!bericht) return json({ error: "Antwort konnte nicht gelesen werden." + (data.stop_reason === "max_tokens" ? " (abgeschnitten)" : "") }, 500);
    return json({ bericht, modell, qualitaet: q, lang, kosten_usd: kosten, ohne_schema: r.ohneFormat, abgeschnitten: data.stop_reason === "max_tokens" });
  }

  // Rueckfrage: Dokumente mit Zitierfunktion, Kontext im Cache (Folgefragen kosten dann nur einen Bruchteil)
  const frage = String(p.frage || "").trim().slice(0, 2000);
  if (!frage) return json({ error: "Keine Frage." }, 400);
  const bericht = p.bericht ? JSON.stringify(p.bericht).slice(0, 40_000) : "";
  const verlauf = (Array.isArray(p.verlauf) ? p.verlauf : []).slice(-6).map((v) => {
    const x = v as { frage?: string; antwort?: string };
    return "Frage: " + String(x.frage || "").slice(0, 1000) + "\nAntwort: " + String(x.antwort || "").slice(0, 3000);
  }).join("\n\n");
  const inhalt: Record<string, unknown>[] = texte.map((t) => ({
    type: "document", title: t.titel, citations: { enabled: true },
    source: { type: "content", content: zeilen(t.text).map((z) => ({ type: "text", text: z })) },
  }));
  inhalt.push({ type: "text", text: kontext.join("\n\n") + "\n\nBERICHT (JSON):\n" + (bericht || "(noch keiner)"), cache_control: { type: "ephemeral" } });
  inhalt.push({ type: "text", text: FRAGE_AUFGABE + sprache(lang) + (p.recherche ? RECHERCHE : "") + (verlauf ? "\n\nBISHERIGE RUECKFRAGEN:\n" + verlauf : "") + "\n\nRUECKFRAGE: " + frage });
  const body: Record<string, unknown> = {
    model: MODELL[q], max_tokens: 8000, system: SYSTEM,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: inhalt }],
  };
  if (p.recherche) body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3, user_location: { type: "approximate", country: "DE" } }];
  let r;
  try { r = await claudeRobust(body, ""); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
  if (!r.resp.ok) return await kiFehler(r.resp);
  const data = await r.resp.json();
  // Lange Recherche: die API unterbricht den Zug (pause_turn) – einmal fortsetzen
  const bloecke: Record<string, unknown>[] = [...(data.content || [])];
  const usage: Record<string, number> = { ...(data.usage || {}) };
  for (let i = 0; i < 1 && data.stop_reason === "pause_turn"; i++) {
    (body.messages as unknown[]).push({ role: "assistant", content: data.content });
    let weiter: Response;
    try { weiter = await senden(body, { fallback: true }); } catch (_) { break; }
    if (!weiter.ok) break;
    const d2 = await weiter.json();
    bloecke.push(...(d2.content || []));
    for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) usage[k] = (Number(usage[k]) || 0) + (Number(d2.usage?.[k]) || 0);
    data.stop_reason = d2.stop_reason;
    data.content = d2.content;
  }
  if (data.stop_reason === "refusal") return json({ error: "Die KI hat die Frage abgelehnt.", code: "abgelehnt" }, 422);
  data.usage = { ...data.usage, ...usage };
  // Text, Zitate aus den Dokumenten, Web-Quellen
  let text = "";
  const belege: { dokument: string; zitat: string }[] = [];
  const quellen: { titel: string; url: string }[] = [];
  for (const b of bloecke) {
    if (b.type !== "text") continue;
    text += String(b.text || "");
    for (const c of (Array.isArray(b.citations) ? b.citations : []) as Record<string, unknown>[]) {
      if (c.url) {
        const url = String(c.url || "");
        if (url && !quellen.some((x) => x.url === url)) quellen.push({ titel: String(c.title || url).slice(0, 200), url });
      } else if (c.cited_text) {
        const zitat = String(c.cited_text).trim().slice(0, 400);
        const dokument = String(c.document_title || "").slice(0, 120);
        if (zitat && !belege.some((x) => x.zitat === zitat)) belege.push({ dokument, zitat });
      }
    }
  }
  if (!quellen.length) {
    for (const b of bloecke) {
      if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
      for (const x of b.content as Record<string, unknown>[]) {
        const url = String(x.url || "");
        if (url && quellen.length < 5 && !quellen.some((y) => y.url === url)) quellen.push({ titel: String(x.title || url).slice(0, 200), url });
      }
    }
  }
  const merken: string[] = [];
  text = text.replace(/^\s*MERKEN:\s*(.+)$/gim, (_m: string, f: string) => { if (merken.length < 2) merken.push(f.trim().slice(0, 300)); return ""; }).trim();
  const modell = String(data.model || MODELL[q]);
  const kosten = await protokoll(chk.wer, "allhome-nk-frage", STUFE[q], MODELL[q], protokollUsage(data.usage), !!text);
  if (!text) return json({ error: "Keine Antwort erhalten." }, 500);
  return json({ antwort: { text, belege: belege.slice(0, 12), quellen: quellen.slice(0, 8), merken }, modell, qualitaet: q, lang, kosten_usd: kosten,
    cache: { gelesen: Number(data.usage?.cache_read_input_tokens) || 0, geschrieben: Number(data.usage?.cache_creation_input_tokens) || 0 } });
});
