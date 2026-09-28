// Chess Arena service worker (roadmap.md D1) — hand-rolled, no dependencies.
//
// Caching policy:
// - Same-origin static files (vite-hashed assets, engine, icons, manifest):
//   cache-first — hashed names never collide, engine files never change.
// - Navigations (index.html): network-first with cache fallback, so new
//   deploys are picked up on the next reload while offline still works.
// - The online room / lobby API: NEVER cached — passed straight to the
//   network so room state is always live.
//
// Registration happens only off-localhost (see src/main.js) so Vite dev is
// never intercepted.

const CACHE_VERSION = 'chess-arena-v1';
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const SHELL_URL = new URL('./', self.registration.scope).href;
const SCOPE_PATH = new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
      // Precache the app shell; failing (e.g. offline at first visit) must NOT
      // fail the whole install — navigations fall back to the network and the
      // shell is cached on the first successful visit instead.
      await cache.add(new Request(SHELL_URL, { cache: 'reload' }));
    } catch {
      // shell will be cached by the network-first navigation handler
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('chess-arena-') && name !== CACHE_VERSION && name !== RUNTIME_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function isStaticAsset(pathname) {
  return pathname.startsWith(`${SCOPE_PATH}assets/`)
    || pathname.startsWith(`${SCOPE_PATH}engine/`)
    || pathname === `${SCOPE_PATH}manifest.webmanifest`
    || pathname === `${SCOPE_PATH}sw.js`;
}

function isApiPath(pathname) {
  return pathname.startsWith(`${SCOPE_PATH}api/`);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // online API is cross-origin
  if (!url.pathname.startsWith(SCOPE_PATH)) return;
  if (isApiPath(url.pathname)) return; // room/lobby state: network only, never cached

  // Static assets: cache-first (hashed names / immutable engine files).
  if (isStaticAsset(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // Navigations / everything else: network-first, fall back to the cached
  // app shell so vs-bot and review work offline.
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && request.mode === 'navigate') cache.put(SHELL_URL, response.clone());
      return response;
    } catch {
      const cached = request.mode === 'navigate'
        ? await cache.match(SHELL_URL)
        : await caches.match(request);
      if (cached) return cached;
      return new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
