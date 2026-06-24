/* PDMap service worker — makes the app installable and lets the app shell
 * (HTML/CSS/JS, globe library, Earth textures, icons) load offline/instantly.
 * Live data (PBDB, Wikipedia) is cross-origin and is never cached — it always
 * goes to the network, so the fossil records and photos stay current. */

const CACHE = "pdmap-shell-v15";

const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./vendor/globe.gl.min.js",
  "./vendor/img/earth-blue-marble.jpg",
  "./vendor/img/earth-topology.png",
  "./vendor/img/night-sky.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Fetch each shell file bypassing the HTTP cache, so we never precache a
      // stale copy. Don't let one missing file abort the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) =>
        fetch(u, { cache: "reload" }).then((res) => res.ok && c.put(u, res)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only manage our own origin. Live API/image calls pass straight through.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: serve the cached copy instantly (fast + offline),
  // and refresh the cache from the network in the background so the next load
  // picks up any deployed updates. Falls back to the cached page when offline.
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req, { cache: "no-cache" }) // revalidate, don't trust heuristic HTTP cache
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached || (req.mode === "navigate" ? cache.match("./index.html") : Response.error()));
        return cached || network;
      })
    )
  );
});
