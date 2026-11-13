// Request and response helpers shared by every route.
//
// Errors go out as a short machine code ({ ok: false, error: "slug_taken" })
// rather than English, so the browser can look the sentence up in its own
// locale file under error.<code>.
//
// No HMAC request signing. Cross-site requests are refused by three things
// together: SameSite=Strict cookies, an Origin check on every state-changing
// method, and a JSON content type, which a plain HTML form cannot send.

import { siteOrigin } from './env.js';

const MAX_BODY_BYTES = 32 * 1024;

// What to log for something caught: its message when it has one, otherwise
// the thing itself (a string, null, or an object without a message).
export function errorDetail(cause) {
  if (cause === null || cause === undefined) {
    return cause;
  }
  if (cause.message === null || cause.message === undefined) {
    return cause;
  }
  return cause.message;
}

export function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  // no-store unless the route chose its own caching (the public event feed).
  if (!response.getHeader('Cache-Control')) {
    response.setHeader('Cache-Control', 'no-store');
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

export function ok(response, data = {}) {
  send(response, 200, { ok: true, ...data });
}

export function fail(response, status, error, extra = {}) {
  send(response, status, { ok: false, error, ...extra });
}

export function failInternal(response, cause, where) {
  console.error(`[helloevents] ${where}:`, errorDetail(cause));
  if (!response.headersSent) {
    fail(response, 500, 'server_error');
  }
}

// Wraps a route so anything thrown becomes a plain 500 with no detail sent.
export function route(name, handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (cause) {
      failInternal(response, cause, name);
    }
  };
}

// Method, origin and content type, in one call at the top of a route.
// Returns true when the request has been answered and the route should stop.
export function guard(request, response, methods) {
  if (!methods.includes(request.method)) {
    response.setHeader('Allow', methods.join(', '));
    fail(response, 405, 'method_not_allowed');
    return true;
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return false;
  }

  const origin = request.headers.origin;
  if (origin !== siteOrigin() && !isLocalDev(origin)) {
    fail(response, 403, 'bad_origin');
    return true;
  }
  let contentType = '';
  if (request.headers['content-type']) {
    contentType = String(request.headers['content-type']);
  }
  if (!contentType.toLowerCase().startsWith('application/json')) {
    fail(response, 415, 'bad_content_type');
    return true;
  }
  return false;
}

// `vercel dev` on localhost, where SITE_URL is still the production origin.
function isLocalDev(origin) {
  if (process.env.VERCEL_ENV === 'production') {
    return false;
  }
  if (typeof origin !== 'string') {
    return false;
  }
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// The parsed JSON body, or null after answering 400. Vercel's Node runtime
// parses JSON bodies itself; the stream fallback covers anything that does not.
export async function readJson(request, response, { maxBytes = MAX_BODY_BYTES } = {}) {
  try {
    let body = request.body;
    if (body === undefined) {
      body = await readStream(request, maxBytes);
    }
    if (typeof body === 'string') {
      if (body === '') {
        body = {};
      } else {
        body = JSON.parse(body);
      }
    }
    if (Buffer.isBuffer(body)) {
      body = JSON.parse(body.toString('utf8'));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('not an object');
    }
    return body;
  } catch {
    fail(response, 400, 'bad_request');
    return null;
  }
}

function readStream(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

// One query string parameter as a string, or '' when it is missing.
// Vercel parses the query string into request.query; anything else is read
// from the URL itself.
export function query(request, name) {
  let value;
  if (request.query !== null && request.query !== undefined) {
    value = request.query[name];
  }
  if (value === null || value === undefined) {
    value = new URL(request.url, 'http://x').searchParams.get(name);
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

// The caller's address: the first one in X-Forwarded-For (set by Vercel),
// then X-Real-IP, then the socket's own address, then 'unknown'.
export function clientIp(request) {
  let forwardedHeader = '';
  if (request.headers['x-forwarded-for']) {
    forwardedHeader = String(request.headers['x-forwarded-for']);
  }
  const forwarded = forwardedHeader.split(',')[0].trim();
  if (forwarded) {
    return forwarded;
  }

  let realIp = '';
  if (request.headers['x-real-ip']) {
    realIp = String(request.headers['x-real-ip']);
  }
  if (realIp) {
    return realIp;
  }

  let remoteAddress;
  if (request.socket !== null && request.socket !== undefined) {
    remoteAddress = request.socket.remoteAddress;
  }
  if (remoteAddress) {
    return remoteAddress;
  }
  return 'unknown';
}

// One cookie's value from the Cookie header, or '' when it is missing or
// cannot be decoded.
export function readCookie(request, name) {
  let header = '';
  if (request.headers.cookie) {
    header = String(request.headers.cookie);
  }
  for (const part of header.split(';')) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex < 0) {
      continue;
    }
    if (part.slice(0, equalsIndex).trim() === name) {
      try {
        return decodeURIComponent(part.slice(equalsIndex + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

// __Host- cookies: Secure, Path=/, no Domain, so no other globalfurry.tv
// subdomain can set or read them. HttpOnly keeps them out of reach of any
// script on the page; SameSite=Strict keeps them off cross-site requests.
export function setCookie(response, name, value, maxAgeSeconds) {
  appendCookie(
    response,
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
  );
}

export function clearCookie(response, name) {
  appendCookie(response, `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

// Adds a Set-Cookie line, keeping any the response already has.
function appendCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie');
  let cookies = [];
  if (Array.isArray(existing)) {
    cookies = existing;
  } else if (existing) {
    cookies = [String(existing)];
  }
  response.setHeader('Set-Cookie', [...cookies, cookie]);
}
