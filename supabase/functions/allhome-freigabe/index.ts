// Supabase Edge Function: allhome-freigabe (v1)
// Freigabe neuer Konten durch den Superadmin (gilt für All-Home und AllTrack).
// modus "melden": von der Datenbank (pg_net) nach bestätigter E-Mail. Schickt allen Superadmins eine Mail
//   mit Vorname, Nachname, E-Mail und zwei Knöpfen (Freigeben/Ablehnen). Der Link trägt ein Einmal-Token
//   (14 Tage gültig, in der DB nur als SHA-256). Höchstens eine Mail je Registrierung – darum ohne Anmeldung.
// modus "info" / "entscheiden": von der Freigabe-Seite der App, nur mit gültigem Token.
// Mailversand über Resend (Secret RESEND_API_KEY). Ohne Schlüssel bleibt die Freigabe in der App (Mehr › Registrierungen).
// Zugriff auf die Datenbank nur über eigene Funktionen, die allein service_role ausführen darf.

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const MAIL_VON = Deno.env.get("FREIGABE_ABSENDER") || "All-Home <onboarding@resend.dev>";
const APP_URL = "https://slizex.github.io/all-home/";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

/* Geheimer Schlüssel (umgeht RLS) – neuer secret key, sonst der alte service_role */
function secretHeaders(): Record<string, string> | null {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}")["default"]; if (typeof k === "string" && k) return { apikey: k }; } catch (_) { /* Rückfall */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return legacy ? { apikey: legacy, authorization: "Bearer " + legacy } : null;
}
async function rpc(name: string, body: unknown): Promise<Record<string, unknown> | null> {
  const sh = secretHeaders();
  if (!sh) return null;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...sh, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { console.error(name, r.status, await r.text()); return null; }
  const t = await r.text();
  if (!t || t === "null") return null;
  try { return JSON.parse(t); } catch (_) { return null; }
}

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function zufallsToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function datum(iso: unknown): string {
  const d = new Date(String(iso || ""));
  return isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });
}
function appName(a: unknown): string {
  return a === "alltrack" ? "AllTrack" : a === "all-home" ? "All-Home" : "All-Home / AllTrack";
}

/* Die Mail an den Superadmin: Angaben + zwei Knöpfe, die zur Freigabe-Seite der App führen */
async function mailSenden(an: string[], d: Record<string, unknown>, token: string): Promise<boolean> {
  const name = [d.vorname, d.nachname].filter(Boolean).join(" ") || "(ohne Namen)";
  const link = (a: string) => `${APP_URL}#/freigabe?t=${encodeURIComponent(token)}&a=${a}`;
  const zeile = (k: string, v: unknown) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#6a6156">${k}</td><td style="padding:6px 0;font-weight:700">${esc(v || "–")}</td></tr>`;
  const knopf = (txt: string, href: string, farbe: string) =>
    `<a href="${href}" style="display:inline-block;padding:12px 22px;margin:0 10px 10px 0;border-radius:999px;background:${farbe};color:#fff;text-decoration:none;font-weight:800">${txt}</a>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#231f1a;max-width:520px">
<h2 style="margin:0 0 6px">Neue Registrierung</h2>
<p style="margin:0 0 16px;color:#6a6156">bei ${esc(appName(d.app))} – die E-Mail-Adresse ist bestätigt.</p>
<table style="border-collapse:collapse;margin:0 0 18px">${zeile("Vorname", d.vorname)}${zeile("Nachname", d.nachname)}${zeile("E-Mail", d.email)}${zeile("Registriert", datum(d.angelegt_am))}</table>
${knopf("Freigeben", link("freigeben"), "#147a4a")}${knopf("Ablehnen", link("ablehnen"), "#b8352b")}
<p style="margin:14px 0 0;font-size:13px;color:#6a6156">Die Knöpfe öffnen All-Home; dort bestätigst du die Entscheidung mit einem Klick.
Ablehnen löscht das Konto. Der Link gilt 14 Tage und nur einmal. Ohne Freigabe sieht das Konto keine Daten.</p></div>`;
  const text = `Neue Registrierung bei ${appName(d.app)}\n\nVorname: ${d.vorname || "–"}\nNachname: ${d.nachname || "–"}\nE-Mail: ${d.email}\n` +
    `Registriert: ${datum(d.angelegt_am)}\n\nFreigeben: ${link("freigeben")}\nAblehnen: ${link("ablehnen")}\n\nDer Link gilt 14 Tage und nur einmal. Ablehnen löscht das Konto.`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + RESEND_API_KEY },
    body: JSON.stringify({ from: MAIL_VON, to: an, subject: `Neue Registrierung: ${name}`, html, text }),
  });
  if (!r.ok) console.error("Resend:", r.status, await r.text());
  return r.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  if (!SB_URL || !secretHeaders()) return json({ error: "Server nicht vollstaendig eingerichtet." }, 500);
  let p: { modus?: string; user_id?: string; token?: string; aktion?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }

  if (p.modus === "melden") {
    if (typeof p.user_id !== "string" || !/^[0-9a-f-]{36}$/i.test(p.user_id)) return json({ error: "Ungueltig." }, 400);
    const d = await rpc("freigabe_melden_daten", { p_user: p.user_id });
    if (!d || d.status !== "offen" || d.gemeldet_am || !d.bestaetigt) return json({ gesendet: false, grund: "nicht_noetig" });
    if (!RESEND_API_KEY) return json({ gesendet: false, grund: "kein_schluessel" });
    const an = (Array.isArray(d.superadmin_mails) ? d.superadmin_mails : []).filter((x) => typeof x === "string" && x) as string[];
    if (!an.length) return json({ gesendet: false, grund: "kein_superadmin" });
    const token = zufallsToken();
    if (!(await mailSenden(an, d, token))) return json({ gesendet: false, grund: "mail_fehler" }, 502);
    await rpc("freigabe_token_setzen", { p_user: p.user_id, p_hash: await sha256Hex(token) });
    return json({ gesendet: true });
  }

  if (p.modus === "info" || p.modus === "entscheiden") {
    if (typeof p.token !== "string" || p.token.length < 20 || p.token.length > 100) return json({ error: "Der Link ist ungueltig." }, 400);
    const hash = await sha256Hex(p.token);
    if (p.modus === "info") {
      const d = await rpc("freigabe_per_token", { p_hash: hash });
      return d ? json({ registrierung: d }) : json({ error: "Der Link ist abgelaufen oder wurde schon benutzt.", code: "verbraucht" }, 404);
    }
    const aktion = p.aktion === "freigeben" || p.aktion === "ablehnen" ? p.aktion : "";
    if (!aktion) return json({ error: "Aktion fehlt." }, 400);
    const d = await rpc("freigabe_entscheiden", { p_hash: hash, p_aktion: aktion });
    return d ? json({ ergebnis: d }) : json({ error: "Der Link ist abgelaufen oder wurde schon benutzt.", code: "verbraucht" }, 404);
  }
  return json({ error: "Unbekannter Modus." }, 400);
});
