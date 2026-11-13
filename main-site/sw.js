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

const VERSION = '2026-11-13.1';
const PREFIX = 'gftv-helloevents-';
const CACHE = PREFIX + VERSION;

const PRECACHE = [
  '/',
  '/event',
  '/login',
  '/account',
  '/manage',
  '/signup',
  '/reset',
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
  '/js/cover-upload.js',
  '/js/push-client.js',
  '/js/manage-tools.js',
  '/js/pages/home.js',
  '/js/pages/event.js',
  '/js/pages/login.js',
  '/js/pages/account.js',
  '/js/pages/manage.js',
  '/js/pages/signup.js',
  '/js/pages/reset.js',
];

// The pages that are part of the shell, by their clean path.
const SHELL_PAGES = new Set(['/', '/event', '/login', '/account', '/manage', '/signup', '/reset']);
const EVENT_PATH = /^\/e\/[a-z0-9-]{3,60}$/;

// A redirected response cannot be served to a navigation, so store a clean copy.
async function fetchForCache(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`precache ${url}: ${response.status}`);
  }
  if (!response.redirected) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(await response.blob(), { status: 200, headers });
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
      Promise.all(
        keys
          .filter((key) => {
            if (!key.startsWith(PREFIX)) {
              return false;
            }
            return key !== CACHE;
          })
          .map((key) => caches.delete(key))
      )
    )
  );
  // No clients.claim() here either; see the message handler.
});

self.addEventListener('message', (event) => {
  // The message is either the bare string, or an object with a type.
  let type;
  if (typeof event.data === 'string') {
    type = event.data;
  } else if (event.data !== null && event.data !== undefined) {
    type = event.data.type;
  }

  // The only place either of these is ever called.
  if (type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

// Web Push (api/_lib/push.js): show what the server sent. The payload is
// { title, body, url, tag }; a notice with the same tag replaces the last.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch {
    let fallbackBody = '';
    if (event.data) {
      fallbackBody = event.data.text();
    }
    data = { title: 'GFTV HelloEvents', body: fallbackBody };
  }

  let title = 'GFTV HelloEvents';
  if (data.title) {
    title = data.title;
  }
  let body = '';
  if (data.body) {
    body = data.body;
  }
  let tag;
  if (typeof data.tag === 'string') {
    tag = data.tag.slice(0, 64);
  }
  let notificationPath = '/';
  if (typeof data.url === 'string') {
    notificationPath = data.url;
  }

  event.waitUntil(
    self.registration.showNotification(String(title).slice(0, 120), {
      body: String(body).slice(0, 300),
      tag,
      icon: '/GHE-192.png',
      badge: '/GHE-192.png',
      data: { url: notificationPath },
    })
  );
});

// Clicking a notice opens its page, on this site only: a tab already on it
// is focused, otherwise a new one opens.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('/', self.location.origin);
  try {
    let requestedPath = '/';
    const notificationData = event.notification.data;
    if (notificationData !== null && notificationData !== undefined && notificationData.url) {
      requestedPath = notificationData.url;
    }
    const url = new URL(requestedPath, self.location.origin);
    if (url.origin === self.location.origin) {
      target = url;
    }
  } catch {
    /* keep the home page */
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const openClient = windowClients.find((windowClient) => windowClient.url === target.href);
      if (openClient) {
        return openClient.focus();
      }
      return self.clients.openWindow(target.href);
    })
  );
});

// /login, /login/ and /login.html are the same page.
function pageKey(url) {
  let path = url.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  if (path.length > 1) {
    path = path.replace(/\/$/, '');
  }
  return path;
}

// Decides, for each request, whether the worker answers it or leaves it to the
// browser. Navigations get the precached shell (or the 404 page offline);
// everything else on this origin is cache first, then network.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    const key = pageKey(url);

    // Shell pages, and every event page (one shell for all of them): from the
    // precache, so they open instantly and offline. The event itself always
    // comes from the network.
    if (SHELL_PAGES.has(key) || EVENT_PATH.test(key)) {
      let shell = key;
      if (EVENT_PATH.test(key)) {
        shell = '/event';
      }
      event.respondWith(
        caches.open(CACHE).then(async (cache) => {
          const cachedShell = await cache.match(shell);
          if (cachedShell) {
            return cachedShell;
          }
          return fetch(request);
        })
      );
      return;
    }

    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        const notFoundPage = await cache.match('/404.html');
        if (notFoundPage) {
          return notFoundPage;
        }
        return Response.error();
      })
    );
    return;
  }

  // Everything else on this origin: cache first, then network, keeping a
  // copy of anything new so it is there next time.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) {
        return cached;
      }
      const response = await fetch(request);
      if (response.ok && !response.redirected) {
        cache.put(request, response.clone());
      }
      return response;
    })
  );
});
