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
  // The on-device OCR engine. ~9.7 MB combined, and deliberately precached
  // here rather than fetched opportunistically from a page: a page-scoped
  // fetch only ever gets a chance to run if the technician happens to visit
  // /scanner while online and stays long enough for it to finish, and is
  // aborted with nothing cached if they navigate away first. Since offline
  // scanning is the one feature that has to work with zero signal, it can't
  // depend on that happening — it has to be guaranteed present the moment
  // the service worker finishes installing, whichever page was opened
  // first. Both wasm variants are included since Tesseract.js picks
  // whichever one the device's SIMD support calls for at runtime, and only
  // caching one would leave devices that need the other with nothing.
  '/static/vendor/tesseract/tesseract.min.js',
  '/static/vendor/tesseract/worker.min.js',
  '/static/vendor/tesseract/tesseract-core-lstm.wasm.js',
  '/static/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  '/static/vendor/tesseract/eng.traineddata.gz',
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

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(RUNTIME);
        cache.put(request, response.clone());
        return response;
      } catch (e) {
        return (await caches.match(request))
            || (await caches.match(url.pathname))
            || (await caches.match('/offline'))
            || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

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
  }
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
