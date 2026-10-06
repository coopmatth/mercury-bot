// Mercury Field Map Service Worker
// Precaches the app shell for instant loading, cache-first for tiles

const CACHE_NAME = 'mercury-fieldmap-v1';
const APP_SHELL = [
  '/fieldmap',
  '/static/vendor/leaflet/leaflet.css',
  '/static/vendor/leaflet/leaflet.js',
  '/static/js/fieldmap.js',
  '/static/js/app.js',
  '/static/css/base.css',
  '/static/manifest.json',
];

// Install: precache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.log('SW install failed:', err))
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for app shell, network-first for API/data
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;
  
  // API calls: network first, don't cache
  if (url.pathname.startsWith('/api/')) return;
  
  // App shell and static assets: cache first
  if (APP_SHELL.some(path => url.pathname === path || url.pathname.startsWith('/static/'))) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            // Cache successful responses
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          });
        })
        .catch(() => {
          // Offline fallback for the map page
          if (url.pathname === '/fieldmap') {
            return caches.match('/fieldmap');
          }
        })
    );
    return;
  }
  
  // Tiles: let the app's IndexedDB cache handle it (don't interfere)
  // Everything else: network first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
