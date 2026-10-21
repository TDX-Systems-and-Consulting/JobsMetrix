// JOBSMETRIX service worker — app-shell caching only.
//
// Scope on purpose: this handles installability and "the app still loads
// with no signal." It deliberately does NOT touch Firestore or Storage
// network calls — those have their own offline handling (Firestore's
// built-in IndexedDB persistence, and the custom photo-upload queue in
// kytrac-app.js). Layering a generic cache-first strategy on top of
// those would fight their retry/sync logic, so this worker only ever
// intercepts same-origin static assets.
const CACHE_NAME = 'jobsmetrix-shell-v2';

const SHELL_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET, same-origin requests. Everything else (Firestore,
  // Storage, Cloud Functions, Google auth popups, any cross-origin call)
  // passes straight through untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never intercept the app's own JS — it's version-stamped via the
  // ?v=YYYYMMDDHHMM query string in index.html specifically so browsers
  // (and this worker) fetch a fresh copy whenever that stamp changes.
  // Caching it here would undermine that mechanism.
  if (url.pathname === '/kytrac-app.js' || url.pathname === '/kytlead.js') return;

  // The app shell itself (index.html / navigations): network-first,
  // not cache-first. This was the actual bug behind "I hard-refreshed
  // and the new button still isn't there" — index.html was previously
  // pre-cached and served cache-first with no way to know its content
  // had changed (nothing bumps a manually-versioned CACHE_NAME on every
  // deploy), so returning users could be stuck on an old cached shell
  // indefinitely regardless of how hard they refreshed. Network-first
  // means a real deploy is visible on next load; cache is only a
  // fallback for genuinely offline loads. Same pattern PlannerXD's
  // service worker already uses for exactly this reason.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Everything else (manifest, icons): cache-first is fine, these
  // essentially never change between deploys.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      }).catch(() => undefined);
    })
  );
});
