// Gemeinsamer Kern der All-Home-KI-Funktionen (butler-extract, -research, -med-explain,
// -translate). Wird jeder Funktion als eigene Datei mitgegeben.
// Wer darf (nur angemeldet, Limit je Person, Tages- und Monatsbudget aus public.ki_einstellungen), was kostet es (public.ai_calls,
// gemeinsam mit AllTracks tarif-extract), und die Anfrage an Claude mit Ersatzmodell.

export const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SB_URL = Deno.env.get("SUPABASE_URL") || "";

/* ---------- Stufen und Preise (wie AllTrack) ---------- */
export type Stufe = "basic" | "advanced" | "max";
export type Level = { model: string; maxTokens: number; effort?: string };
const MODELLE: Record<Stufe, string> = { basic: "claude-haiku-4-5", advanced: "claude-sonnet-5-5", max: "claude-opus-5-5" };
// US-Dollar je 1 Mio. Tokens (Eingabe, Ausgabe); Websuche 10 $ je 1000 Suchen
const PREISE: Record<string, [number, number]> = { "claude-haiku-4-5": [1, 5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };
const USD_JE_SUCHE = 0.01;
// Grenzen stellt der Superadmin in der Zentrale ein (public.ki_einstellungen, gilt auch für AllTrack).
// Nur wenn die Datenbank nicht antwortet, gelten diese Rückfallwerte.
const RUECKFALL = { limit: 60, tag: 5, monat: 50 };

export function stufe(v?: string): Stufe {
  if (v === "ultra") return "max";
  return v === "basic" || v === "advanced" || v === "max" ? v : "advanced";
}
/* tok: maximale Antwortlänge je Stufe; Haiku kennt kein effort */
export function level(st: Stufe, tok: Record<Stufe, number>): Level {
  return st === "basic" ? { model: MODELLE.basic, maxTokens: tok.basic } : { model: MODELLE[st], maxTokens: tok[st], effort: "medium" };
}

/* ---------- Antworten ---------- */
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

/* ---------- Schlüssel ---------- */
function publicKey(): string | undefined {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}")["default"]; if (typeof k === "string" && k) return k; } catch (_) { /* Rückfall */ }
  return Deno.env.get("SUPABASE_ANON_KEY") || undefined;
}
function secretHeaders(): Record<string, string> | null {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}")["default"]; if (typeof k === "string" && k) return { apikey: k }; } catch (_) { /* Rückfall */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return legacy ? { apikey: legacy, authorization: "Bearer " + legacy } : null;
}

/* ---------- Wer ruft auf, darf er? ---------- */
export type Aufrufer = { id: string; email: string; hh: string | null; modus: string };
// verify_jwt prüft nur die Signatur – auch der öffentliche anon-Schlüssel der App ist ein
// gültiges JWT. Darum: Rolle prüfen und den Nutzer beim Auth-Dienst nachschlagen.
function rolleAngemeldet(auth: string): boolean {
  const teil = auth.replace(/^Bearer\s+/i, "").split(".")[1];
  if (!teil) return false;
  try {
    const p = JSON.parse(atob(teil.replace(/-/g, "+").replace(/_/g, "/")));
    return p.role === "authenticated" && typeof p.sub === "string" && p.sub.length > 0;
  } catch (_) { return false; }
}
async function rpc(name: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
}
/* Abgewiesenen Aufruf ins Ereignisprotokoll der Zentrale (best effort) */
async function abgewiesen(wer: Aufrufer, grund: string): Promise<void> {
  const sh = secretHeaders();
  if (!sh || !SB_URL) return;
  try {
    const r = await rpc("ki_abgewiesen_melden", sh, { p_user: wer.id, p_email: wer.email, p_household: wer.hh, p_grund: grund, p_modus: wer.modus });
    if (!r.ok) console.error("ki_abgewiesen_melden:", r.status, await r.text());
  } catch (e) { console.error("ki_abgewiesen_melden:", String(e)); }
}
/* Liefert den Aufrufer – oder die fertige Ablehnung. hhWunsch zählt nur, wenn er Mitglied ist. modus: wofür (Protokoll) */
export async function pruefeAufruf(req: Request, hhWunsch: unknown, modus = ""): Promise<{ wer: Aufrufer } | { antwort: Response }> {
  const auth = req.headers.get("authorization") || "";
  const key = publicKey();
  if (!rolleAngemeldet(auth) || !key || !SB_URL) return { antwort: json({ error: "Bitte anmelden.", code: "login" }, 401) };
  let id = "", email = "";
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: key, authorization: auth } });
    if (r.ok) { const u = await r.json(); id = String(u?.id || ""); email = String(u?.email || ""); }
  } catch (_) { /* unten abgelehnt */ }
  if (!id) return { antwort: json({ error: "Bitte anmelden.", code: "login" }, 401) };
  const sh = secretHeaders();
  let hh: string | null = null;
  if (sh && typeof hhWunsch === "string" && /^[0-9a-f-]{36}$/i.test(hhWunsch)) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/household_members?select=user_id&household_id=eq.${hhWunsch}&user_id=eq.${encodeURIComponent(id)}`, { headers: sh });
      const rows = r.ok ? await r.json() : [];
      if (Array.isArray(rows) && rows.length) hh = hhWunsch;
    } catch (_) { /* ohne Haus protokollieren */ }
  }
  const wer: Aufrufer = { id, email, hh, modus: String(modus || "").slice(0, 40) };
  // Grenzen und bisherige Kosten aus der Datenbank (ein Aufruf)
  let g: { limit?: number; tag?: number; monat?: number; heute?: number; monat_kosten?: number } | null = null;
  if (sh) {
    try { const r = await rpc("ki_grenzen", sh, {}); if (r.ok) g = await r.json(); } catch (_) { /* Rückfall unten */ }
  }
  // Limit je Person (fail-open bei Technikfehlern, fail-closed beim echten Limit; gesperrte Konten: keine KI)
  try {
    const r = await rpc("ai_usage_bump", { apikey: key, authorization: auth }, { p_max: Number(g?.limit) || RUECKFALL.limit });
    if (!r.ok) {
      const t = await r.text();
      if (/nicht freigegeben/.test(t)) return { antwort: json({ error: "Dein Konto ist nicht freigegeben.", code: "gesperrt" }, 403) };
      if (/ai_quota_exceeded/.test(t)) { await abgewiesen(wer, "limit"); return { antwort: json({ error: "Tageslimit für KI-Auswertungen erreicht. Morgen geht es weiter.", code: "limit" }, 429) }; }
    }
  } catch (_) { /* Kontingent inaktiv */ }
  // Tages- und Monatsbudget aller Nutzer (beide Apps zusammen)
  if (g) {
    if (Number(g.heute) >= Number(g.tag ?? RUECKFALL.tag)) { await abgewiesen(wer, "budget"); return { antwort: json({ error: "Das KI-Tagesbudget ist ausgeschöpft. Morgen geht es weiter.", code: "budget" }, 429) }; }
    if (Number(g.monat_kosten) >= Number(g.monat ?? RUECKFALL.monat)) { await abgewiesen(wer, "budget_monat"); return { antwort: json({ error: "Das KI-Monatsbudget ist ausgeschöpft.", code: "budget" }, 429) }; }
  } else if (sh) {
    try {
      const r = await rpc("ai_cost_today", sh, {});
      if (r.ok && Number(await r.json()) >= RUECKFALL.tag) { await abgewiesen(wer, "budget"); return { antwort: json({ error: "Das KI-Tagesbudget ist ausgeschöpft. Morgen geht es weiter.", code: "budget" }, 429) }; }
    } catch (_) { /* weiter */ }
  }
  return { wer };
}

/* ---------- Kosten protokollieren (lesen dürfen nur Admins des Hauses) ---------- */
export async function protokoll(wer: Aufrufer, mode: string, st: Stufe, modell: string,
  usage: Record<string, unknown> | undefined, ok: boolean): Promise<number> {
  const inp = Number(usage?.input_tokens) || 0, out = Number(usage?.output_tokens) || 0;
  const suchen = Number((usage?.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests) || 0;
  const preisKey = Object.keys(PREISE).find((k) => modell.indexOf(k) === 0) || "";
  const p = PREISE[preisKey] || [0, 0];
  const usd = Math.round(((inp * p[0] + out * p[1]) / 1e6 + suchen * USD_JE_SUCHE) * 1e6) / 1e6;
  const sh = secretHeaders();
  if (sh && SB_URL) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/ai_calls`, {
        method: "POST", headers: { ...sh, "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({ household_id: wer.hh, user_id: wer.id, user_email: wer.email, env: "live", mode, level: st, model: modell, input_tokens: inp, output_tokens: out, cost_usd: usd, ok }),
      });
      if (!r.ok) console.error("ai_calls:", r.status, await r.text());
    } catch (e) { console.error("ai_calls:", String(e)); }
  }
  return usd;
}

/* ---------- Claude ---------- */
// Anfrage; ist das Modell abgeschaltet, einmal mit Sonnet 5.5 (effort low) wiederholen
export async function claude(lv: Level, body: Record<string, unknown>): Promise<{ resp: Response; lv: Level }> {
  const senden = (l: Level) => {
    const b: Record<string, unknown> = { ...body, model: l.model, max_tokens: l.maxTokens };
    if (l.effort) b.output_config = { effort: l.effort };
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(b),
    });
  };
  let resp = await senden(lv);
  const ersatz: Level = { model: MODELLE.advanced, maxTokens: lv.maxTokens, effort: "low" };
  if ((resp.status === 404 || resp.status === 400) && lv.model !== ersatz.model) {
    const peek = await resp.clone().text();
    if (/model/i.test(peek) && /not_found|not found|invalid|unknown|deprecated/i.test(peek)) {
      console.warn("Modell nicht verfuegbar, nutze Ersatz:", lv.model);
      lv = ersatz;
      resp = await senden(lv);
    }
  }
  return { resp, lv };
}
/* Fehlerantwort von Claude in eine klare Meldung übersetzen; Guthaben/Limit bei Anthropic → Ereignisprotokoll */
export async function claudeFehler(resp: Response, was: string, wer?: Aufrufer): Promise<Response> {
  const detail = await resp.text();
  const d = detail.toLowerCase();
  if (resp.status === 402 || /credit balance|insufficient|billing|payment required|quota|out of credits/.test(d)) {
    if (wer) await abgewiesen(wer, "ki_guthaben");
    return json({ error: "Das KI-Guthaben ist aufgebraucht. Bitte spaeter erneut versuchen.", code: "ki_guthaben" }, 402);
  }
  if (resp.status === 429) { if (wer) await abgewiesen(wer, "ki_limit"); return json({ error: "KI-Limit erreicht (429). Bitte spaeter erneut versuchen.", code: "limit" }, 429); }
  if (resp.status === 401) return json({ error: "KI-Schluessel ungueltig (401)." }, 502);
  console.error(was, resp.status, detail.slice(0, 500));
  return json({ error: was + " fehlgeschlagen (" + resp.status + ")." }, 502);
}
/* Text aller Textblöcke einer Claude-Antwort */
export function antwortText(data: { content?: { type: string; text?: string }[] }): string {
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
}

/* ---------- JSON aus der Antwort, auch abgeschnitten ---------- */
export function repairJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const tryParse = (s: string) => { try { const r = JSON.parse(s); return r && typeof r === "object" ? r : null; } catch (_) { return null; } };
  let r = tryParse(t);
  if (r) return r;
  const s = t.indexOf("{");
  if (s < 0) return null;
  t = t.slice(s);
  const e = t.lastIndexOf("}");
  if (e > 0) { r = tryParse(t.slice(0, e + 1)); if (r) return r; }
  // abgeschnitten: letzten halben Eintrag weg, offene Strings/Klammern schliessen
  let depth = 0, inStr = false, esc = false, lastGood = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) lastGood = i; }
    else if (c === "," && depth >= 1) lastGood = i;
  }
  if (lastGood <= 0) return null;
  let frag = t.slice(0, lastGood).replace(/,\s*$/, "");
  const offen: string[] = [];
  inStr = false; esc = false;
  for (let i = 0; i < frag.length; i++) {
    const c = frag[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") offen.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") offen.pop();
  }
  if (inStr) frag += '"';
  while (offen.length) frag += offen.pop();
  return tryParse(frag);
}
