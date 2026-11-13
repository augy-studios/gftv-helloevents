// The local server the end-to-end tests run against. playwright.config.js
// starts it with `node tests/e2e/server.js`; it is never deployed
// (.vercelignore leaves tests/ out).
//
// It stands in for Vercel, closely enough for a browser:
//   - main-site/ is served as static files with vercel.json's cleanUrls,
//     trailingSlash, rewrites (/e/<slug> -> event.html) and headers, so the
//     real Content-Security-Policy applies to every page;
//   - /api/<path> runs the real handler in api/<path>.js, with the request
//     shaped the way Vercel's Node runtime shapes it (req.query, req.cookies,
//     a parsed JSON req.body, x-forwarded-for);
//   - the handlers talk to the same in-memory database (tests/fake-db.js)
//     and Redis (tests/fake-redis.js) as `npm test`, through the same hooks
//     the unit tests use (useTestClient, useTestRedis, useTestPushSender);
//   - anything else answers 404 with 404.html.
//
// Nothing leaves the machine. Turnstile runs with Cloudflare's test keys,
// and its siteverify call is answered here (answerSiteverify; the token
// format is in stubs.js). Any other outgoing fetch from a handler is refused
// and logged. Telegram is left switched off. Web Push is on with a key pair
// made at start-up, and pushes are recorded instead of sent.
//
// Test-only routes, under /__e2e__/ (not part of the site):
//   POST /__e2e__/reset  a fresh database and Redis, seeded (seed.js)
//   GET  /__e2e__/state  what the stubs saw since the last reset: Turnstile
//                        checks, pushes, refused fetches, and any API answer
//                        that carried a field from tests/harness.js's
//                        SECRET_FIELDS list
//
// It listens on a free port on 127.0.0.1 and prints
// "e2e server listening on http://localhost:<port>", which
// playwright.config.js waits for and hands to the tests as E2E_PORT.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import webpush from 'web-push';
import { leaks } from '../harness.js';
import { createFakeDb } from '../fake-db.js';
import { createFakeRedis } from '../fake-redis.js';
import { seedDatabase } from './seed.js';
import { TURNSTILE_TEST_SITE_KEY, TURNSTILE_TEST_SECRET, PASSING_TOKEN } from './stubs.js';

const SITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_ROOT = join(SITE_ROOT, 'api');
const VERCEL = JSON.parse(readFileSync(join(SITE_ROOT, 'vercel.json'), 'utf8'));
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ---------------------------------------------------------------------------
// Environment. Set here, for this process only, so the handlers see the same
// values on every machine. Names are the ones in .env.example. Anything that
// would reach a real service is cleared, in case the shell that started the
// tests has it set.
// ---------------------------------------------------------------------------

const CLEARED_VARIABLES = [
  'VERCEL_ENV',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_WEBHOOK_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'WEBAUTHN_RP_ID',
  'WEBAUTHN_ORIGIN',
  'TURNSTILE_SECRET_KEY',
];

function stubEnvironment() {
  for (const name of CLEARED_VARIABLES) {
    delete process.env[name];
  }
  const vapidKeys = webpush.generateVAPIDKeys();
  Object.assign(process.env, {
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    IP_HASH_SALT: 'e2e-salt',
    CRON_SECRET: 'e2e-cron-secret',
    TURNSTILE_SECRET: TURNSTILE_TEST_SECRET,
    TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
    TURNSTILE_HOSTNAMES: 'localhost',
    VAPID_PUBLIC_KEY: vapidKeys.publicKey,
    VAPID_PRIVATE_KEY: vapidKeys.privateKey,
    VAPID_SUBJECT: 'mailto:e2e@example.org',
  });
}

stubEnvironment();

// Imported after the environment is set, so nothing reads it early.
const { useTestClient } = await import('../../api/_lib/supabase.js');
const { useTestRedis } = await import('../../api/_lib/redis.js');
const { useTestPushSender } = await import('../../api/_lib/push.js');
const { forgetNameFilters } = await import('../../api/_lib/name-filter.js');

// ---------------------------------------------------------------------------
// State: the fake database and Redis, and what the stubs saw. Replaced
// whole by /__e2e__/reset before every test.
// ---------------------------------------------------------------------------

let observed = null;

async function resetState() {
  const database = createFakeDb();
  await seedDatabase(database);
  useTestClient(database);
  useTestRedis(createFakeRedis());
  forgetNameFilters();
  observed = { turnstile: [], pushes: [], refusedFetches: [], leaks: [], serverErrors: [] };
}

await resetState();

useTestPushSender(async (subscription, body) => {
  observed.pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) });
});

// Turnstile's siteverify, answered here. A token from the browser stub passes,
// for the action it was made for and on localhost; anything else fails the
// way Cloudflare fails a bad token.
function answerSiteverify(init) {
  const form = new URLSearchParams(String(init.body));
  const token = form.get('response');
  const match = PASSING_TOKEN.exec(String(token));
  let answer = { success: false, 'error-codes': ['invalid-input-response'] };
  if (form.get('secret') === TURNSTILE_TEST_SECRET && match) {
    answer = { success: true, action: match[1], hostname: 'localhost', 'error-codes': [] };
  }
  observed.turnstile.push({ action: answer.action, success: answer.success, hostname: answer.hostname });
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (input, init = {}) => {
  let url = String(input);
  if (input instanceof Request) {
    url = input.url;
  }
  if (url === SITEVERIFY) {
    return answerSiteverify(init);
  }
  observed.refusedFetches.push(url);
  console.error(`[e2e] refused an outgoing fetch to ${url}`);
  throw new TypeError(`the e2e server does not reach the network (${url})`);
};

// ---------------------------------------------------------------------------
// vercel.json patterns. Sources are path-to-regexp patterns; this handles
// the forms vercel.json uses: literal text, ":name(regex)", ":name" and a
// bare "(regex)" group.
// ---------------------------------------------------------------------------

function closingParenthesis(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(`unbalanced pattern: ${text}`);
}

function sourceToRegExp(source) {
  let pattern = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const named = /^:(\w+)/.exec(source.slice(index));
    if (named) {
      index += named[0].length;
      if (source[index] === '(') {
        const end = closingParenthesis(source, index);
        pattern += source.slice(index, end + 1);
        index = end + 1;
      } else {
        pattern += '([^/]+)';
      }
    } else if (character === '(') {
      const end = closingParenthesis(source, index);
      pattern += source.slice(index, end + 1);
      index = end + 1;
    } else {
      pattern += character.replace(/[.*+?^${}|[\]\\/]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

// A list from vercel.json, or an empty one when the key is not there.
function configured(key) {
  if (Array.isArray(VERCEL[key])) {
    return VERCEL[key];
  }
  return [];
}

const REWRITES = configured('rewrites').map((rule) => ({ source: sourceToRegExp(rule.source), destination: rule.destination }));
const HEADER_RULES = configured('headers').map((rule) => ({ source: sourceToRegExp(rule.source), headers: rule.headers }));

function applyConfiguredHeaders(pathname, response) {
  for (const rule of HEADER_RULES) {
    if (rule.source.test(pathname)) {
      for (const header of rule.headers) {
        response.setHeader(header.key, header.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Never served: what .vercelignore keeps out of a deploy, the functions'
// source, installed packages, and dotfiles other than .well-known.
const HIDDEN_TOP_LEVEL = new Set(['api', 'tests', 'scripts', 'node_modules', 'README.md', 'playwright.config.js']);

function isServable(pathname) {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length > 0 && HIDDEN_TOP_LEVEL.has(segments[0])) {
    return false;
  }
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '.well-known') {
      return false;
    }
  }
  return true;
}

// The file on disk for a URL path, or null. Stays inside main-site/.
async function fileFor(pathname) {
  if (!isServable(pathname)) {
    return null;
  }
  const file = normalize(join(SITE_ROOT, pathname));
  if (!file.startsWith(SITE_ROOT) || file.split(sep).includes('..')) {
    return null;
  }
  try {
    const info = await stat(file);
    if (info.isFile()) {
      return file;
    }
  } catch {
    return null;
  }
  return null;
}

async function sendFile(request, response, file, status = 200) {
  const body = await readFile(file);
  let type = CONTENT_TYPES[extname(file)];
  if (!type) {
    type = 'application/octet-stream';
  }
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  if (!response.getHeader('Cache-Control')) {
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  response.setHeader('Content-Length', body.length);
  if (request.method === 'HEAD') {
    response.end();
  } else {
    response.end(body);
  }
}

function redirect(response, location) {
  response.statusCode = 308;
  response.setHeader('Location', location);
  response.end();
}

// Vercel's order for a static request: the trailing slash and .html
// redirects, then the file system (with cleanUrls), then rewrites, then 404.
async function serveStatic(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  if (VERCEL.trailingSlash === false && pathname.length > 1 && pathname.endsWith('/')) {
    redirect(response, pathname.replace(/\/+$/, '') + url.search);
    return;
  }
  if (VERCEL.cleanUrls && pathname.endsWith('.html')) {
    let clean = pathname.slice(0, -'.html'.length);
    if (clean === '/index') {
      clean = '/';
    }
    redirect(response, clean + url.search);
    return;
  }

  let file = null;
  if (pathname === '/') {
    file = await fileFor('/index.html');
  } else {
    file = await fileFor(pathname);
    if (!file && VERCEL.cleanUrls) {
      file = await fileFor(`${pathname}.html`);
    }
  }
  if (!file) {
    for (const rewrite of REWRITES) {
      if (rewrite.source.test(pathname)) {
        file = await fileFor(rewrite.destination);
        break;
      }
    }
  }
  if (file) {
    await sendFile(request, response, file);
    return;
  }
  await sendFile(request, response, join(SITE_ROOT, '404.html'), 404);
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// The default export of api/<route>.js, or null. Folders and files starting
// with "_" (api/_lib) are not routes on Vercel, and the pattern keeps them out.
async function handlerFor(pathname) {
  const route = pathname.slice('/api/'.length);
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(route)) {
    return null;
  }
  const file = join(API_ROOT, `${route}.js`);
  try {
    await stat(file);
  } catch {
    return null;
  }
  const module = await import(pathToFileURL(file).href);
  return module.default;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function queryObject(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (key in query) {
      query[key] = [].concat(query[key], value);
    } else {
      query[key] = value;
    }
  }
  return query;
}

function cookieObject(header) {
  const cookies = {};
  if (typeof header !== 'string') {
    return cookies;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return cookies;
}

// Every API answer is checked as it goes out: a field from tests/harness.js's
// list of fields that must never reach a browser, or a 5xx from a handler,
// is logged and kept for the tests to see (fixtures.js fails the test).
function watchAnswer(request, pathname, response) {
  const end = response.end.bind(response);
  response.end = (chunk, ...rest) => {
    if (response.statusCode >= 500) {
      observed.serverErrors.push(`${request.method} ${pathname} answered ${response.statusCode}`);
    }
    if (chunk) {
      try {
        const found = leaks(JSON.parse(String(chunk)));
        if (found.length > 0) {
          observed.leaks.push({ path: pathname, fields: found });
          console.error(`[e2e] ${pathname} answered with secret fields: ${found.join(', ')}`);
        }
      } catch {
        // Not JSON: nothing to check.
      }
    }
    return end(chunk, ...rest);
  };
}

async function serveApi(request, response, url) {
  const handler = await handlerFor(url.pathname);
  if (!handler) {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('NOT_FOUND');
    return;
  }

  // What Vercel's Node runtime adds to the request.
  request.query = queryObject(url.searchParams);
  request.cookies = cookieObject(request.headers.cookie);
  request.headers['x-forwarded-for'] = request.socket.remoteAddress;
  request.headers['x-real-ip'] = request.socket.remoteAddress;
  const type = String(request.headers['content-type']).toLowerCase();
  if (type.startsWith('application/json')) {
    const text = await readBody(request);
    try {
      request.body = JSON.parse(text);
    } catch {
      // Left as text: readJson (api/_lib/http.js) then answers bad_request.
      request.body = text;
    }
  }

  watchAnswer(request, url.pathname, response);
  await handler(request, response);
  if (!response.writableEnded) {
    observed.serverErrors.push(`${url.pathname} did not answer`);
    console.error(`[e2e] ${request.method} ${url.pathname} returned without answering`);
    response.statusCode = 500;
    response.end();
  }
}

// ---------------------------------------------------------------------------
// The test-only routes
// ---------------------------------------------------------------------------

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

async function serveControl(request, response, url) {
  if (url.pathname === '/__e2e__/reset' && request.method === 'POST') {
    await resetState();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === '/__e2e__/state' && request.method === 'GET') {
    sendJson(response, 200, observed);
    return;
  }
  sendJson(response, 404, { ok: false });
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/__e2e__/')) {
      await serveControl(request, response, url);
      return;
    }
    applyConfiguredHeaders(url.pathname, response);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await serveApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end();
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    if (observed) {
      observed.serverErrors.push(`${url.pathname}: ${error.message}`);
    }
    console.error(`[e2e] ${request.method} ${url.pathname} failed:`, error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end();
    }
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // The site's own origin, for the Origin check on writes and anything that
  // builds a link to the site.
  process.env.SITE_URL = `http://localhost:${port}`;
  console.log(`e2e server listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
