/* All-Home Service Worker — network-first (immer frisch, offline Fallback) */
var CACHE = "allhome-shell-v41";
/* Gleiche Domain wie AllTrack: der Cache-Speicher ist geteilt, aufgeräumt wird nur der eigene */
var PREFIX = "allhome-shell-";

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add(new Request("./index.html", { cache: "reload" })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return; /* Supabase & CDNs nie anfassen */
  /* Die Seite selbst (und .json) immer beim Server nachfragen: GitHub Pages erlaubt sonst 10 Minuten
     Zwischenspeicher – die App zeigte dann nach einem Update noch die alte Fassung. Unverändert = kurze 304-Antwort. */
  var frisch = e.request.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname) || /\.json$/.test(url.pathname);
  e.respondWith(
    fetch(frisch ? new Request(e.request, { cache: "no-cache" }) : e.request).then(function (resp) {
      /* Nur gute Antworten merken – eine Fehlerseite darf die letzte gute Fassung nicht überschreiben */
      if (resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (m) { return m || caches.match("./index.html"); });
    })
  );
});
