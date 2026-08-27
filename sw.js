const CACHE_NAME = 'rajabsynic-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/scripts/app.js',
  '/scripts/payment.js',
  '/scripts/firebase-config.js',
  '/scripts/api.js',
  '/manifest.json'
];

// ─── Install: cache static assets ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).catch(err => console.warn('SW install cache error:', err))
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// ─── Fetch: network-first, fallback to cache ──────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Skip non-GET and cross-origin requests (Firebase, CDNs)
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache fresh copy of local resources
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache
        return caches.match(event.request).then(cached => {
          return cached || caches.match('/index.html');
        });
      })
  );
});

// ─── Push Notifications (native) ──────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'RAJABSYNIC', body: 'Ujumbe mpya umefika!' };
  try {
    data = event.data.json();
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || 'https://via.placeholder.com/192x192/0b0c10/00ff00?text=RS',
      badge: 'https://via.placeholder.com/96x96/00ff00/000000?text=RS',
      vibrate: [200, 100, 200],
      tag: 'rajabsynic-notif',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
