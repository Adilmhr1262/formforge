/* FormForge service worker: cache the app shell so the site keeps working
   after its first load with network access disabled. Version the cache so
   a new deploy replaces it. No user data is cached here; forms and
   responses live in IndexedDB, not in this cache. */
var CACHE = 'formforge-v1';
var FILES = ['index.html', 'style.css', 'app.js'];
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(event.request).catch(function () { return caches.match('index.html'); });
  }));
});
