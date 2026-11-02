// Caches only the static shell so the app opens instantly. Everything else (every /api/ call, the TV's live
// state) is never intercepted: no respondWith, so it always goes to the network. Bump CACHE to drop old copies.
const CACHE = 'webos-foundry-shell-v3';
const SHELL = ['/', '/index.html', '/app.css', '/tokens.css', '/theme.js', '/app.js', '/apps.js', '/favicon.svg',
  '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Shell files: answer from cache at once, refresh the copy in the background (a forgotten version bump
// then only costs one stale load, never a permanently stale UI).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    if (!cached) return fresh;
    fresh.catch(() => {});  // offline: the cached copy already answered
    return cached;
  }));
});
