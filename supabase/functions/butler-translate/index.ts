// Supabase Edge Function: butler-translate
// Uebersetzt gespeicherte KI-Texte in eine Zielsprache; Struktur und Schluessel bleiben.
// v3: nur angemeldete Nutzer, Tageslimit/Budget, Kosten in public.ai_calls.
// Gemeinsamer Kern (Anmeldung, Limits, Kosten-Protokoll, Claude-Aufruf): gemeinsam.ts

import { ANTHROPIC_API_KEY, antwortText, claude, claudeFehler, cors, json, level, protokoll, pruefeAufruf, repairJson, stufe } from "./gemeinsam.ts";

const SPRACHE: Record<string, string> = { ru: "Russisch", de: "Deutsch" };
const MAX_CHARS = 60_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "Der KI-Schluessel ist noch nicht hinterlegt." }, 500);
  let p: { texte?: unknown; ziel?: string; quelle?: string; model?: string; level?: string; lang?: string; household_id?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }
  const chk = await pruefeAufruf(req, p.household_id, "allhome-translate");
  if ("antwort" in chk) return chk.antwort;
  const ziel = String(p.ziel || "").toLowerCase();
  if (!SPRACHE[ziel]) return json({ error: "Zielsprache wird nicht unterstuetzt." }, 400);
  const quelle = SPRACHE[String(p.quelle || "de").toLowerCase()] || "Deutsch";
  if (p.texte == null) return json({ error: "Keine Texte empfangen." }, 400);
  const roh = JSON.stringify(p.texte);
  if (roh.length > MAX_CHARS) return json({ error: "Zu viel Text auf einmal." }, 413);
  const st = stufe(p.level || p.model || "basic");
  const lv = level(st, { basic: 8000, advanced: 8000, max: 8000 });
  const lang = ziel;

  const anweisung = [
    `Du uebersetzt Texte einer privaten Dokumenten-Verwaltung von ${quelle} nach ${SPRACHE[ziel]}.`,
    ``,
    `Du bekommst ein JSON. Gib GENAU DIESELBE Struktur zurueck - gleiche Schluessel, gleiche Verschachtelung,`,
    `gleiche Array-Laengen - aber alle Textwerte uebersetzt. Zahlen, Datumsangaben, Betraege, URLs,`,
    `E-Mail-Adressen und JSON-Schluessel bleiben unveraendert.`,
    ``,
    `Regeln fuer die Uebersetzung:`,
    `- Eigennamen (Firmen, Anbieter, Arztpraxen, Produkt- und Tarifnamen) NICHT uebersetzen.`,
    `- Deutsche Fach- und Behoerdenbegriffe (z. B. Sonderkuendigungsrecht, Mindestlaufzeit, Schadenfreiheitsklasse,`,
    `  GOAe-Ziffer, SEPA-Mandat) uebersetzen UND den deutschen Begriff in Klammern dahinter setzen,`,
    `  damit man ihn auf dem Papier wiedererkennt. Beispiel: "Право на досрочное расторжение (Sonderkuendigungsrecht)".`,
    `- Natuerliche, gut lesbare Alltagssprache. Keine woertliche Wort-fuer-Wort-Uebersetzung.`,
    `- Leere Strings bleiben leer. null bleibt null.`,
    ``,
    `Gib AUSSCHLIESSLICH das JSON zurueck, ohne Markdown, ohne Erklaerung.`,
  ].join("\n");

  const body = { messages: [{ role: "user", content: anweisung + "\n\nJSON:\n" + roh }] };
  let r;
  try { r = await claude(lv, body); } catch (e) { return json({ error: "KI nicht erreichbar: " + String(e), code: "netz" }, 502); }
  if (!r.resp.ok) return await claudeFehler(r.resp, "Uebersetzung", chk.wer);
  const data = await r.resp.json();
  if (data.stop_reason === "refusal") return json({ error: "Die KI hat dieses Dokument nicht ausgewertet." }, 422);
  const parsed = repairJson(antwortText(data));
  const modell = String(data.model || r.lv.model);
  const kosten = await protokoll(chk.wer, "allhome-translate", st, modell, data.usage, !!parsed);
  if (!parsed) return json({ error: "Antwort konnte nicht gelesen werden." }, 500);
  return json({ uebersetzung: parsed, modell, stufe: st, lang, kosten_usd: kosten });
});
