const VERSION = '__MERCURY_BUILD__';
const SHELL = `mercury-shell-${VERSION}`;
const RUNTIME = `mercury-runtime-${VERSION}`;

const PRECACHE = [
  '/',
  '/jobs',
  '/jobs/new',
  '/custom',
  '/scanner',
  '/photos',
  '/reports',
  '/settings',
  '/offline',
  '/static/css/app.css',
  '/static/js/store.js',
  '/static/js/sync.js',
  '/static/js/app.js',
  '/static/js/local.js',
  '/static/js/hydrate.js',
  '/static/js/job-form.js',
  '/static/js/scanner.js',
  '/static/js/photos.js',
  '/static/js/native.js',
  // The OCR engine used to be precached here — ~9.7 MB of Tesseract wasm on
  // every install. On-device reading is now Apple's Vision framework, which
  // lives in the packaged app and needs nothing cached to work offline.
  '/static/icons/logo.png',
  '/manifest.webmanifest',
  '/api/bootstrap',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

function isStatic(url) {
  return url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (
    url.pathname.includes('/export/') ||
    url.pathname.includes('/pdf') ||
    url.pathname.includes('/backup')
  ) {
    return; 
  }

  // 1. Handle API Requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(RUNTIME);
        cache.put(request, response.clone());
        return response;
      } catch (e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(JSON.stringify({ ok: false, offline: true }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // 2. Handle Static Files (CSS, JS, Images, WASM)
  if (isStatic(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      const cache = await caches.open(SHELL);
      cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  // 3. Handle HTML Pages (Native Navigations & SPA Router Fetches)
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      const cache = await caches.open(RUNTIME);
      cache.put(request, response.clone());
      return response;
    } catch (e) {
      // EXPLICITLY check the fresh RUNTIME cache before the frozen SHELL cache
      const runtimeCache = await caches.open(RUNTIME);
      let cached = (await runtimeCache.match(request)) || (await runtimeCache.match(url.pathname));

      // Fall back to the original SHELL install only if RUNTIME is empty
      if (!cached) {
        cached = (await caches.match(request)) || (await caches.match(url.pathname));
      }

      return cached
          || (await caches.match('/offline'))
          || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

self.addEventListener('sync', (event) => {
  if (event.tag !== 'mercury-sync') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach((client) => client.postMessage({ type: 'sync-now' }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});
