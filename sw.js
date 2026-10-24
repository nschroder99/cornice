// Offline: precache the app and all stock photos; fonts are cached the first time they load.
const PRECACHE = 'precache.json';
const VERSION = '2026-10-24T18:50:11.099Z'; // rewritten by scripts/build-content.js so browsers pick up new content

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
    await Promise.all(keys.filter(k => k.startsWith('cornice-') && k !== 'cornice-' + VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open('fonts').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
