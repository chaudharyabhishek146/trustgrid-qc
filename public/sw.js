/**
 * Service worker — app-shell cache + Background Sync hook.
 *
 * SCOPE NOTE (see README "What is deliberately not built"): the durable outbox
 * and the resume logic are fully implemented in IndexedDB and run in the page.
 * What this worker adds is the ability for the browser to wake the sync when
 * connectivity returns WHILE THE APP IS CLOSED. The message-passing handoff to
 * the page is the honest MVP version; a production build moves the fetch loop
 * itself in here so uploads continue with no tab open at all.
 *
 * iOS Safari does not implement Background Sync. The page-level fallbacks —
 * an `online` listener plus a resume-on-focus pass — cover the realistic field
 * pattern of the inspector reopening the app for the next truck.
 */
const CACHE = 'trustgrid-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Never cache the API: a stale inspection status is worse than no status.
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request).catch(() => caches.match(request).then((r) => r || caches.match('/'))),
  );
});

// Fired by the browser when connectivity returns — even if the app is closed.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-inspections') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'DRAIN_OUTBOX' }));
      }),
    );
  }
});
