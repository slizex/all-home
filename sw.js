/* All-Home Service Worker — network-first (immer frisch, offline Fallback) */
var CACHE = "allhome-shell-v24";
/* Gleiche Domain wie AllTrack: der Cache-Speicher ist geteilt, aufgeräumt wird nur der eigene */
var PREFIX = "allhome-shell-";

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(["./index.html"]); }).then(function () { return self.skipWaiting(); }));
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
  e.respondWith(
    fetch(e.request).then(function (resp) {
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
