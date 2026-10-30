// Supabase Edge Function: butler-research
// Reichert einen Vertrag per KI-Websuche mit oeffentlichen Tarif-/Leistungsdetails an.
// v7: nur angemeldete Nutzer, Tageslimit/Budget, Kosten in public.ai_calls.
// Gemeinsamer Kern (Anmeldung, Limits, Kosten-Protokoll, Claude-Aufruf): gemeinsam.ts

import { ANTHROPIC_API_KEY, antwortText, claude, claudeFehler, cors, json, level, protokoll, pruefeAufruf, repairJson, stufe } from "./gemeinsam.ts";

// Sprachvorgabe fuer die Freitextfelder; Recherchequellen bleiben deutschsprachig.
function langHinweis(lang: string): string {
  if (lang !== "ru") return "";
  return [
    ``,
    `WICHTIG - SPRACHE: Recherchiere weiterhin in deutschen Quellen, aber schreibe ALLE Freitexte`,
    `("leistungen", "zusammenfassung", "hinweise") auf RUSSISCH.`,
    `Eigennamen (Anbieter, Tarifnamen) NICHT uebersetzen.`,
    `Deutsche Fachbegriffe uebersetzen und den deutschen Begriff in Klammern dahinter setzen,`,
    `z. B. "Минимальный срок (Mindestlaufzeit)". Zahlenwerte bleiben unveraendert.`,
  ].join("\n");
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "Der KI-Schluessel ist noch nicht hinterlegt." }, 500);
  let p: { anbieter?: string; produkt?: string; kategorie?: string; kosten?: number; kostenIntervall?: string; vertragsstart?: string; model?: string; level?: string; lang?: string; household_id?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }
  const chk = await pruefeAufruf(req, p.household_id, "allhome-research");
  if ("antwort" in chk) return chk.antwort;
  const anbieter = String(p.anbieter || "").slice(0, 120).trim();
  if (!anbieter) return json({ error: "Kein Anbieter angegeben." }, 400);
  const produkt = String(p.produkt || "").slice(0, 120).trim();
  const kategorie = String(p.kategorie || "").slice(0, 40).trim();
  const st = stufe(p.level || p.model);
  const lv = level(st, { basic: 6000, advanced: 6000, max: 8000 });
  const lang = (p.lang === "ru") ? "ru" : "de";

  const frage = [
    `Du bist der Recherche-Assistent eines deutschen Privathaushalts (\"Dokumenten-Butler\").`,
    `Recherchiere im Internet oeffentliche Informationen zu diesem Vertrag/Tarif:`,
    `- Anbieter: ${anbieter}`,
    produkt ? `- Tarif/Produkt: ${produkt}` : ``,
    kategorie ? `- Kategorie: ${kategorie}` : ``,
    p.kosten != null ? `- Bekannter Preis: ${p.kosten} EUR ${p.kostenIntervall || ""}` : ``,
    p.vertragsstart ? `- Vertragsbeginn: ${p.vertragsstart}` : ``,
    ``,
    `Gesucht sind insbesondere die ENTHALTENEN LEISTUNGEN dieses Tarifs, typische Vertragskonditionen (Mindestlaufzeit, Kuendigungsfrist, Verlaengerung) und aktuelle Hinweise (Tarif eingestellt, Preiserhoehungen, Nachfolgetarif).`,
    ``,
    `Gib nach der Recherche AUSSCHLIESSLICH ein JSON-Objekt zurueck (kein Markdown) mit genau diesen Schluesseln:`,
    `- \"leistungen\": Array kurzer Stichpunkte mit den enthaltenen Leistungen (leer wenn nichts Belastbares).`,
    `- \"zusammenfassung\": 2-4 Saetze.`,
    `- \"tarifdetails\": {\"mindestlaufzeitMonate\":Zahl|null,\"kuendigungsfristMonate\":Zahl|null,\"verlaengerungMonate\":Zahl|null,\"kosten\":Zahl|null,\"kostenIntervall\":string|null} - nur belegte Werte.`,
    `- \"quellen\": Array von {\"titel\":string,\"url\":string} (max. 5).`,
    `- \"hinweise\": kurzer Hinweis zu Unsicherheiten; leer \"\" wenn keiner.`,
    ``,
    `Regeln: Nur oeffentlich recherchierbare Fakten, keine Vermutungen. Geldbetraege in EURO als Zahl. Wenn der exakte Tarif nicht auffindbar ist, beschreibe das in hinweise und gib allgemeine Infos zum Anbieter.`,
    langHinweis(lang),
  ].filter(Boolean).join("\n");

  const body = { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }], messages: [{ role: "user", content: frage }] };
  let r;
  try { r = await claude(lv, body); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
  if (!r.resp.ok) return await claudeFehler(r.resp, "Recherche", chk.wer);
  const data = await r.resp.json();
  if (data.stop_reason === "refusal") return json({ error: "Die KI hat dieses Dokument nicht ausgewertet." }, 422);
  const parsed = repairJson(antwortText(data));
  const modell = String(data.model || r.lv.model);
  const kosten = await protokoll(chk.wer, "allhome-research", st, modell, data.usage, !!parsed);
  if (!parsed) return json({ error: "Antwort konnte nicht gelesen werden." }, 500);
  return json({ recherche: parsed, modell, stufe: st, lang, kosten_usd: kosten });
});
