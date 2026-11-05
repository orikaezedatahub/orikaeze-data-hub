const CACHE_NAME = "orikaeze-hub-shell-v1";
const APP_SHELL = [
  "./manifest.webmanifest",
  "./icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Only cache the app's public icon and manifest. Account, wallet, payment,
// transaction and API requests are deliberately left untouched.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.endsWith("/manifest.webmanifest") && !url.pathname.endsWith("/icons/icon.svg")) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
