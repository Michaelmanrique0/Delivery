/* Red primero; si no hay internet, la última copia guardada de la app. */
const CACHE_NAME = 'delivery-shell-v6';

function respuestaCacheable(res) {
  if (!res) return false;
  if (res.type === 'opaque') return true;
  return res.ok;
}

function esShellApp(url, req) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  return (
    req.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webmanifest')
  );
}

async function redLuegoCache(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (respuestaCacheable(res)) cache.put(req, res.clone()).catch(() => undefined);
    return res;
  } catch (_e) {
    const cached =
      (await cache.match(req)) ||
      (await caches.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await caches.match('./index.html') : null);
    return cached || Response.error();
  }
}

async function cacheLuegoRed(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const red = fetch(req)
    .then((res) => {
      if (respuestaCacheable(res)) cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => cached);
  return cached || red;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg']).catch(() => undefined))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  if (esShellApp(url, req)) {
    event.respondWith(redLuegoCache(req));
    return;
  }
  event.respondWith(cacheLuegoRed(req));
});
