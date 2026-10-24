// Offline: precache the app and all stock photos; fonts are added to the same cache the first time they load.
const PRECACHE = 'precache.json';
const VERSION = '2026-10-24T20:32:56.340Z'; // rewritten by scripts/build-content.js so browsers pick up new content

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const { files } = await fetch(PRECACHE, { cache: 'no-store' }).then(r => r.json());
    const cache = await caches.open('cornice-' + VERSION);
    await cache.addAll(files.map(f => new Request(f, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // Remove this app's old versions (and the old shared 'fonts' cache); leave other sites' caches alone.
    await Promise.all(keys.filter(k => (k.startsWith('cornice-') && k !== 'cornice-' + VERSION) || k === 'fonts').map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Only ever answer from this app's own versioned cache. github.io is shared with other sites,
// so caches.match() across every cache on the origin could serve something another site stored.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isFont = FONT_HOSTS.includes(url.hostname);
  if (!isFont && url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open('cornice-' + VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: !isFont });
    if (hit) return hit;
    const res = await fetch(e.request);
    // Fonts are cached on first use; opaque (no-cors) responses can't be inspected, but errors can.
    if (isFont && (res.ok || res.type === 'opaque')) cache.put(e.request, res.clone());
    return res;
  })());
});
