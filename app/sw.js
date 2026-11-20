// Offline support: app files are network-first with a cache fallback,
// Google Fonts are cached at runtime so the app works offline after the first visit.
const CACHE = 'kria-v6';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'content.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !isFont) return;
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // login & sync always go to the server
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const fresh = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    });
    // fonts: cache first (they never change); app files: network first so updates arrive, cache when offline
    if (isFont && cached) return cached;
    return fresh.catch(() => cached || Response.error());
  }));
});
