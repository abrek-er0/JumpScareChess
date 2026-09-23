// Static-host isolation and on-demand engine caching. Keep this file next to
// index.html so its scope includes both the page and Stockfish's workers.
const cachePrefix = `jumpscare-engine:${self.registration.scope}:`;
// Bump this version whenever the bundled Stockfish JS or WASM changes.
const engineCacheName = `${cachePrefix}19.0.0-full-v1`;
const engineDirectory = new URL('vendor/stockfish/', self.registration.scope);

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== engineCacheName).map(name => caches.delete(name)));
    } catch { /* Restricted storage must not disable multithreading. */ }
    await self.clients.claim();
  })());
});

function isolatedResponse(response) {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function engineResponse(event) {
  let cache;
  try {
    cache = await caches.open(engineCacheName);
    const saved = await cache.match(event.request);
    if (saved) return saved;
  } catch { /* Download normally if browser storage is unavailable. */ }

  const response = await fetch(event.request);
  // Cache only complete, successful files. Stream the download to Stockfish
  // immediately while a clone is saved; do not wait for the disk write.
  if (cache && response.status === 200 && !response.redirected) {
    event.waitUntil(cache.put(event.request, response.clone()).catch(() => {}));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || (request.cache === 'only-if-cached' && request.mode !== 'same-origin')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const filename = url.pathname.slice(engineDirectory.pathname.length);
  const isEngine = url.pathname.startsWith(engineDirectory.pathname) && /^stockfish-19(?:-single)?\.(?:js|wasm)$/.test(filename);
  // App HTML/modules and opening data use normal HTTP freshness, so a cached
  // engine never traps visitors on an old app version. No engine is prefetched.
  event.respondWith((isEngine ? engineResponse(event) : fetch(request)).then(isolatedResponse));
});
