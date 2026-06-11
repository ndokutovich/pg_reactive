// What to Buy — Service Worker
// Provides offline caching for the PWA shell

var CACHE_NAME = 'wtb-v11';
// Only files that actually ship in the image. Each variant is built as its
// OWN image with a single index.html — there are no vue.html/react.html/...
// files, and listing them made cache.addAll() reject the whole precache (it
// is atomic), so install failed and the SW never activated → no offline.
var SHELL_FILES = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

// Install: cache the app shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // API calls: always go to network (match regardless of base path prefix)
  if (/\/(rest|auth|api|ws)\//.test(url.pathname)) {
    return;
  }

  // Static assets: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});
