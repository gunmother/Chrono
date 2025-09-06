// ---- Chrono Service Worker (v2025-09-06) ----
const CACHE_VERSION = 'v7'; // bump on every release
const CACHE_NAME = `chrono-${CACHE_VERSION}`;

// Derive base URL from the SW scope so it works on subpaths too
const BASE = new URL(self.registration.scope);

// Core files to precache (relative to scope)
const CORE = [
  './',           // same as start_url="."
  './index.html',
  // add other static assets here if you have them:
  // './styles.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', (event) => {
  // Ensure new SW installs immediately
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const urls = CORE.map((p) => new URL(p, BASE).toString());
      return cache.addAll(urls);
    })
  );
});

self.addEventListener('activate', (event) => {
  // Take control right away and clean old caches
  event.waitUntil((async () => {
    self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.startsWith('chrono-') && k !== CACHE_NAME) ? caches.delete(k) : null));
  })());
});

// Helper: is same-origin GET
function isCacheableRequest(req) {
  return req.method === 'GET' && new URL(req.url).origin === self.location.origin;
}

// App Shell / SPA navigation fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET
  if (!isCacheableRequest(req)) return;

  // If it's a navigation (user loading a page), serve index.html as shell
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const shellUrl = new URL('./index.html', BASE).toString();
      const cached = await cache.match(shellUrl);
      try {
        // Try network in background; update cache for next time
        const fresh = await fetch(req);
        return fresh; // if server serves real routes, this will win
      } catch {
        // Offline: fall back to shell
        if (cached) return cached;
        // last-chance: try root
        return caches.match('/');
      }
    })());
    return;
  }

  // Static assets / API GET (cache-first, then network)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const resp = await fetch(req);
      // Optionally: only cache successful, non-opaque responses
      if (resp && resp.status === 200 && resp.type === 'basic') {
        cache.put(req, resp.clone());
      }
      return resp;
    } catch (e) {
      return cached || Promise.reject(e);
    }
  })());
});