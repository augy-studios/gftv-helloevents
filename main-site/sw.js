// GFTV HelloEvents service worker.
//
// Precaches the app shell, and never activates a new version on its own: it
// installs, then waits until the page sends "skip-waiting" from the update
// bar. See update-bar-spec.md. `npm run check-sw` fails if skipWaiting() or
// clients.claim() appears anywhere outside that handler.
//
// Bump VERSION on every deploy that changes anything below or anything in
// PRECACHE. The browser compares this file byte for byte; if nothing here
// changes, nobody is told.
//
// What is never cached: /api/ (answers are per person and change, and the
// feed must show new events), and other origins (cover pictures, Google
// Analytics, Turnstile). Event pages at /e/<slug> are the event.html shell,
// which fetches the event itself.

const VERSION = '2026-10-26.1';
const PREFIX = 'gftv-helloevents-';
const CACHE = PREFIX + VERSION;

const PRECACHE = [
  '/',
  '/event',
  '/login',
  '/account',
  '/manage',
  '/404.html',
  '/style.css',
  '/manifest.json',
  '/favicon.ico',
  '/gftv-flag.png',
  '/GHE-180.png',
  '/GHE-192.png',
  '/GHE-512.png',
  '/assets/fonts/ProximaNova-Regular.woff2',
  '/assets/i18n/i18n.js',
  '/assets/i18n/locales.js',
  '/assets/i18n/switcher.js',
  '/assets/i18n/boot.js',
  '/assets/i18n/en.json',
  '/js/prepaint.js',
  '/js/official-bar.js',
  '/js/analytics.js',
  '/js/app.js',
  '/js/theme.js',
  '/js/icons.js',
  '/js/ui.js',
  '/js/api.js',
  '/js/update-bar.js',
  '/js/password-toggle.js',
  '/js/passkeys.js',
  '/js/turnstile.js',
  '/js/qr.js',
  '/js/codes.js',
  '/js/format.js',
  '/js/cards.js',
  '/js/vendor/qrcode.js',
  '/js/pages/home.js',
  '/js/pages/event.js',
  '/js/pages/login.js',
  '/js/pages/account.js',
  '/js/pages/manage.js',
];

// The pages that are part of the shell, by their clean path.
const SHELL_PAGES = new Set(['/', '/event', '/login', '/account', '/manage']);
const EVENT_PATH = /^\/e\/[a-z0-9-]{3,60}$/;

// A redirected response cannot be served to a navigation, so store a clean copy.
async function fetchForCache(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
  if (!res.redirected) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(await res.blob(), { status: 200, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(PRECACHE.map(async (url) => cache.put(url, await fetchForCache(url))));
    })
  );
  // No skipWaiting() here. The update bar asks for it.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  // No clients.claim() here either; see the message handler.
});

self.addEventListener('message', (event) => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;

  // The only place either of these is ever called.
  if (type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

// /login, /login/ and /login.html are the same page.
function pageKey(url) {
  let path = url.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    const key = pageKey(url);

    // Shell pages, and every event page (one shell for all of them): from the
    // precache, so they open instantly and offline. The event itself always
    // comes from the network.
    if (SHELL_PAGES.has(key) || EVENT_PATH.test(key)) {
      const shell = EVENT_PATH.test(key) ? '/event' : key;
      event.respondWith(
        caches.open(CACHE).then(async (cache) => (await cache.match(shell)) || fetch(req))
      );
      return;
    }

    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match('/404.html')) || Response.error();
      })
    );
    return;
  }

  // Everything else on this origin: cache first, then network, keeping a
  // copy of anything new so it is there next time.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && !res.redirected) cache.put(req, res.clone());
      return res;
    })
  );
});
