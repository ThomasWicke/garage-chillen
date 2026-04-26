// Network-only for HTML/JS so daily-deploy stale-cache bugs cannot occur.
// Cache only static assets that won't change between commits.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isStatic = /\.(svg|png|jpg|jpeg|webp|woff2?|ico)$/i.test(url.pathname);
  if (!isStatic) return; // let the network handle it normally

  event.respondWith(
    caches.open("garage-chillen-static").then((cache) =>
      cache.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
      }),
    ),
  );
});
