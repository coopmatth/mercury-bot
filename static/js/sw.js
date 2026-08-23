/* Service worker.
 *
 * Strategy by request type:
 *   - navigations  -> network first, fall back to the cached page, then /offline
 *   - static assets -> cache first (they are versioned by the cache name)
 *   - GET /api/*   -> network first with a cached copy as the fallback
 *   - writes       -> never cached; the app queues them in IndexedDB instead
 */

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
  '/static/vendor/tesseract/tesseract.min.js',
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

  // Direct bypass for exports, SQLite downloads, and PDFs
  if (
    url.pathname.startsWith('/api/export') ||
    url.pathname.startsWith('/settings/backup') ||
    url.pathname.includes('/pdf')
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
