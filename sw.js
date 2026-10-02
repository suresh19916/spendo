// Spendo service worker — caches the app shell so the installed app
// opens instantly and works offline. Apps Script API calls are never cached.
const CACHE = "spendo-v17";
const SHELL = [
  "./",
  "index.html",
  "manifest.json",
  "logo.png",
  "logo-sm.png",
  "home-hero.jpg",
  "home-brand.png",
  "home-track.png",
  "home-manage.png",
  "home-build.png",
  "home-plan.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Live data — always network (script.google.com redirects to googleusercontent.com)
  if (url.hostname.endsWith("script.google.com") || url.hostname.endsWith("googleusercontent.com")) return;

  // Google Fonts — cache-first
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell — stale-while-revalidate: open instantly from cache, fetch the
  // latest copy in the background (a new deploy shows on the next open)
  const fresh = fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  });
  e.waitUntil(fresh.catch(() => {}));
  e.respondWith(
    caches.match(req).then(hit => hit || fresh.catch(() =>
      req.mode === "navigate" ? caches.match("index.html") : Response.error()))
  );
});
