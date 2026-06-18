/* PDMap service worker — makes the app installable and lets the app shell
 * (HTML/CSS/JS, globe library, Earth textures, icons) load offline/instantly.
 * Live data (PBDB, Wikipedia) is cross-origin and is never cached — it always
 * goes to the network, so the fossil records and photos stay current. */

const CACHE = "pdmap-shell-v1";

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
      // Don't let one missing file abort the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
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

  // Cache-first for the app shell, with a network fallback that also warms
  // the cache. If everything fails on a navigation, serve the cached page.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))
    )
  );
});
