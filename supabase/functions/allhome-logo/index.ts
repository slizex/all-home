// Supabase Edge Function: allhome-logo (v1)
// Holt fuer einen Anbieter das App-Symbol von dessen Website und legt es im
// oeffentlichen Bucket "anbieter-logos" ab. Nur App-Admins (butler.app_admins).
// Eingabe: { domain: "axa.de" }  ->  { url, quelle, typ, bytes }
// Sicherheit: nur https, nur oeffentliche Hostnamen (keine IP, kein localhost),
// Umleitungen einzeln geprueft, nur PNG/JPEG/WebP/ICO (kein SVG), max. 400 KB,
// Dateityp wird an den ersten Bytes erkannt, nicht am Header.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const BUCKET = "anbieter-logos";
const MAX_BYTES = 400 * 1024;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Mobile Safari/537.36 All-Home-Logo";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

function publicKey(): string | undefined {
  try {
    const all = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    if (all) { const k = JSON.parse(all)["default"]; if (typeof k === "string" && k) return k; }
  } catch (_) { /* Rueckfall */ }
  return Deno.env.get("SUPABASE_ANON_KEY") || undefined;
}
function secretHeaders(): Record<string, string> | null {
  let k: string | undefined;
  try { const all = Deno.env.get("SUPABASE_SECRET_KEYS"); if (all) k = JSON.parse(all)["default"]; } catch (_) { k = undefined; }
  if (typeof k === "string" && k) return { apikey: k };
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return { apikey: legacy, authorization: "Bearer " + legacy };
  return null;
}

async function whoAmI(auth: string): Promise<string | null> {
  const key = publicKey();
  if (!SB_URL || !key || !auth) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: key, authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? String(u.id) : null;
  } catch (_) { return null; }
}
async function istAppAdmin(uid: string, sh: Record<string, string>): Promise<boolean> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_admins?select=user_id&user_id=eq.${encodeURIComponent(uid)}`,
      { headers: { ...sh, "accept-profile": "butler" } });
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (_) { return false; }
}

// ---- sicheres Abrufen ----
function hostErlaubt(h: string): boolean {
  h = h.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(h)) return false;          // braucht eine echte Endung, keine IP
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/.test(h)) return false;
  if (/(^|\.)supabase\.(co|in|net)$/.test(h)) return false;            // nichts aus der eigenen Infrastruktur
  return true;
}
async function sicherHolen(start: string, maxBytes: number): Promise<{ url: string; typ: string; bytes: Uint8Array } | null> {
  let url = start;
  for (let i = 0; i < 4; i++) {
    let u: URL;
    try { u = new URL(url); } catch (_) { return null; }
    if (u.protocol !== "https:" || !hostErlaubt(u.hostname) || (u.port && u.port !== "443")) return null;
    let r: Response;
    try {
      r = await fetch(u.toString(), { redirect: "manual", headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(8000) });
    } catch (_) { return null; }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return null;
      url = new URL(loc, u).toString();
      continue;
    }
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const teile: Uint8Array[] = [];
    let n = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) { try { await reader.cancel(); } catch (_) { /* egal */ } return null; }
      teile.push(value);
    }
    const bytes = new Uint8Array(n);
    let o = 0;
    for (const t of teile) { bytes.set(t, o); o += t.length; }
    return { url: u.toString(), typ: (r.headers.get("content-type") || "").toLowerCase(), bytes };
  }
  return null;
}

// Dateityp an den ersten Bytes erkennen
function bildTyp(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length < 8) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", ext: "webp" };
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return { mime: "image/x-icon", ext: "ico" };
  return null;
}

type Kandidat = { url: string; punkte: number };
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}
function groesse(s: string | null): number {
  if (!s) return 0;
  let best = 0;
  for (const p of s.split(/\s+/)) { const m = p.match(/^(\d+)x(\d+)$/i); if (m) best = Math.max(best, Number(m[1])); }
  return best;
}
function punkte(rel: string, href: string, sizes: string | null, type: string | null): number {
  if (/\.svg(\?|$)/i.test(href) || /svg/i.test(type || "")) return -1;      // SVG nicht
  let p = 0;
  if (/apple-touch-icon/i.test(rel)) p += 200;
  const g = groesse(sizes);
  p += g ? Math.min(g, 512) / 2 : (/apple-touch-icon/i.test(rel) ? 90 : 10);
  if (/\.ico(\?|$)/i.test(href)) p -= 60;
  if (g && g < 64) p -= 80;
  return p;
}

async function kandidatenVon(seite: string, html: string): Promise<Kandidat[]> {
  const k: Kandidat[] = [];
  const kopf = html.slice(0, 300000);
  for (const tag of kopf.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, "rel") || "").toLowerCase();
    const href = attr(tag, "href");
    if (!href) continue;
    if (/icon/.test(rel)) {
      const p = punkte(rel, href, attr(tag, "sizes"), attr(tag, "type"));
      if (p >= 0) { try { k.push({ url: new URL(href, seite).toString(), punkte: p }); } catch (_) { /* weiter */ } }
    } else if (rel === "manifest") {
      try {
        const mu = new URL(href, seite).toString();
        const m = await sicherHolen(mu, 200000);
        if (m) {
          const man = JSON.parse(new TextDecoder().decode(m.bytes));
          for (const ic of (man.icons || [])) {
            if (!ic || !ic.src) continue;
            const p = punkte("manifest", ic.src, ic.sizes || null, ic.type || null);
            if (p >= 0) k.push({ url: new URL(ic.src, mu).toString(), punkte: p + 20 });
          }
        }
      } catch (_) { /* Manifest unlesbar */ }
    }
  }
  try { const base = new URL(seite); k.push({ url: base.origin + "/apple-touch-icon.png", punkte: 150 }); k.push({ url: base.origin + "/favicon.ico", punkte: 1 }); } catch (_) { /* egal */ }
  const gesehen = new Set<string>();
  return k.filter((x) => { if (gesehen.has(x.url)) return false; gesehen.add(x.url); return true; }).sort((a, b) => b.punkte - a.punkte);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  const sh = secretHeaders();
  if (!SB_URL || !sh) return json({ error: "Server nicht vollstaendig eingerichtet." }, 500);

  const uid = await whoAmI(req.headers.get("Authorization") || "");
  if (!uid) return json({ error: "Nicht angemeldet." }, 401);
  if (!(await istAppAdmin(uid, sh))) return json({ error: "Nur fuer App-Admins.", code: "not_admin" }, 403);

  let p: { domain?: string };
  try { p = await req.json(); } catch (_) { return json({ error: "Ungueltige Anfrage." }, 400); }
  let domain = String(p.domain || "").trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  if (!hostErlaubt(domain)) return json({ error: "Bitte eine Website wie axa.de angeben." }, 400);

  let seite: { url: string; typ: string; bytes: Uint8Array } | null = null;
  for (const start of [`https://www.${domain}/`, `https://${domain}/`]) {
    seite = await sicherHolen(start, 1_500_000);
    if (seite) break;
  }
  const kandidaten = seite
    ? await kandidatenVon(seite.url, new TextDecoder().decode(seite.bytes))
    : [{ url: `https://www.${domain}/apple-touch-icon.png`, punkte: 150 }, { url: `https://${domain}/apple-touch-icon.png`, punkte: 140 }, { url: `https://www.${domain}/favicon.ico`, punkte: 1 }];

  for (const kd of kandidaten.slice(0, 8)) {
    const bild = await sicherHolen(kd.url, MAX_BYTES);
    if (!bild || bild.bytes.length < 200) continue;
    const typ = bildTyp(bild.bytes);
    if (!typ) continue;
    const name = domain.replace(/[^a-z0-9]+/g, "-") + "-" + Date.now() + "." + typ.ext;
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${name}`, {
      method: "POST",
      headers: { ...sh, "content-type": typ.mime, "x-upsert": "true", "cache-control": "31536000" },
      body: bild.bytes,
    });
    if (!up.ok) return json({ error: "Logo konnte nicht gespeichert werden (" + up.status + ").", detail: (await up.text()).slice(0, 200) }, 502);
    return json({ url: `${SB_URL}/storage/v1/object/public/${BUCKET}/${name}`, quelle: bild.url, typ: typ.mime, bytes: bild.bytes.length });
  }
  return json({ error: seite ? "Auf der Website wurde kein passendes Logo gefunden. Lade stattdessen ein Bild hoch." : "Die Website war nicht erreichbar.", code: "kein_logo" }, 404);
});
