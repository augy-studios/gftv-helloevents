// Cloudflare Turnstile: the "are you a person" check on the public forms
// that anyone can send without being signed in (Help desk #10):
//
//   action "login"   sign-in, step one (the password)        api/auth/login.js
//   action "signup"  a new public account                    api/auth/signup.js
//   action "reset"   starting a forgotten-password reset     api/auth/recover.js
//                    (every reset way, Telegram, backup code or a staff code,
//                    needs the challenge that step hands out)
//
// The page draws the widget with the site key api/public/config.js hands it
// (TURNSTILE_SITE_KEY, or the HelloEvents widget's key below) and sends the
// token as "cf-turnstile-response" in the JSON body. This checks the token
// with Cloudflare's siteverify using TURNSTILE_SECRET, and passes only when
// Cloudflare says success, the token was made for this form's action, and on
// one of our hostnames (TURNSTILE_HOSTNAMES). A token works once and lasts
// 300 seconds, so the page resets the widget after every try.
//
// It adds to the rate limits, the venue sign-up allowances and the name
// filter; it replaces none of them. They run as before around it.
//
// Without TURNSTILE_SECRET:
//   - production (VERCEL_ENV=production): refused, fail closed, with
//     human_check_unavailable and an error in the logs. A missing secret in
//     production is a mistake to notice, not a reason to let bots through.
//   - anywhere else (vercel dev, previews, tests): the check is skipped,
//     said once in the logs, and the page is given no site key so it draws
//     no widget. Local work and preview URLs (which are not on the widget's
//     hostname list) keep working.
// If Cloudflare cannot be reached in time, or answers with an error, the
// request is refused: the person can try again.
//
// Nothing here logs the token, the secret or the IP address.

import { optionalEnv, siteUrl } from './env.js';
import { fail, clientIp } from './http.js';

// The HelloEvents widget's site key (public by design: every visitor's
// browser sees it). TURNSTILE_SITE_KEY overrides it, for Cloudflare's test
// key 1x00000000000000000000AA on a local or preview deploy, say.
export const SITE_KEY = '0x4AAAAAAFoBqV14BTwQSjRX';
// The JSON field the token travels in, Cloudflare's own name for it.
export const TOKEN_FIELD = 'cf-turnstile-response';

const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TIMEOUT_MILLISECONDS = 10_000;
// Cloudflare's limit on a token's length.
const MAX_TOKEN_LENGTH = 2048;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let warned = false;

const isProduction = () => process.env.VERCEL_ENV === 'production';

// TURNSTILE_SECRET is Cloudflare's name for it; TURNSTILE_SECRET_KEY, the
// name gftv-linktree uses, is read too, so a value copied from there works.
function turnstileSecret() {
  const secret = optionalEnv('TURNSTILE_SECRET');
  if (secret) {
    return secret;
  }
  return optionalEnv('TURNSTILE_SECRET_KEY');
}

// Checked at all: a secret is set, or this is production (where a missing
// secret refuses instead).
export function turnstileOn() {
  if (turnstileSecret() !== '' || isProduction()) {
    return true;
  }
  return false;
}

// What the page draws the widget with, or null when nothing is checked.
export function turnstileSiteKey() {
  if (turnstileOn()) {
    return optionalEnv('TURNSTILE_SITE_KEY', SITE_KEY);
  }
  return null;
}

// The hostnames a token may come from: TURNSTILE_HOSTNAMES, comma-separated,
// or SITE_URL's hostname when that is blank. Production never accepts
// localhost or 127.0.0.1, whatever the variable says.
export function allowedHostnames() {
  let configured = optionalEnv('TURNSTILE_HOSTNAMES');
  if (!configured) {
    configured = new URL(siteUrl()).hostname;
  }
  const hostnames = configured
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
  if (isProduction()) {
    return hostnames.filter((hostname) => !LOCAL_HOSTS.has(hostname));
  }
  return hostnames;
}

// An error code from Cloudflare that means our own setup is wrong (a bad
// secret, say), rather than a person failing the check.
function isSetupError(code) {
  if (code.includes('secret') || code === 'internal-error') {
    return true;
  }
  return false;
}

// The check by itself, for the tests and for routes that answer their own
// way: { ok: true } or { ok: false, status, error, reason }. reason is for
// the logs and tests only; the browser gets error alone.
//
// In order: no secret (skipped, or refused in production), no usable
// hostname (refused), a malformed token, Cloudflare's siteverify (refused
// when unreachable or not a success), then the token's action and hostname.
export async function verifyTurnstile(request, token, action) {
  const secret = turnstileSecret();
  if (!secret) {
    if (isProduction()) {
      console.error('[helloevents] turnstile: TURNSTILE_SECRET is not set in production; refusing');
      return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'no_secret' };
    }
    if (!warned) {
      console.warn('[helloevents] turnstile: TURNSTILE_SECRET is not set; the check is skipped (not production)');
    }
    warned = true;
    return { ok: true, skipped: true };
  }
  const hostnames = allowedHostnames();
  if (hostnames.length === 0) {
    console.error('[helloevents] turnstile: TURNSTILE_HOSTNAMES has no usable hostname; refusing');
    return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'no_hostnames' };
  }
  const refused = (reason) => ({ ok: false, status: 403, error: 'human_check_failed', reason });
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) {
    return refused('bad_token');
  }

  let data;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
      body: new URLSearchParams({ secret, response: token, remoteip: clientIp(request) }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    data = await response.json();
  } catch (cause) {
    let timedOut = false;
    if (cause !== null && cause !== undefined && cause.name === 'TimeoutError') {
      timedOut = true;
    }
    // "timed out", else the error's message, else the error as text.
    let detail;
    if (timedOut) {
      detail = 'timed out';
    } else {
      if (cause !== null && cause !== undefined) {
        detail = cause.message;
      }
      if (detail === null || detail === undefined) {
        detail = String(cause);
      }
    }
    console.warn('[helloevents] turnstile siteverify:', detail);
    if (timedOut) {
      return refused('timeout');
    }
    return refused('unreachable');
  }

  // data is Cloudflare's JSON answer, so any part of it may be missing.
  let success;
  if (data !== null && data !== undefined) {
    success = data.success;
  }
  if (success !== true) {
    let codes = [];
    if (data !== null && data !== undefined && Array.isArray(data['error-codes'])) {
      codes = data['error-codes'].map(String);
    }
    // Our own setup is wrong (a bad secret, say): worth an error in the logs.
    if (codes.some(isSetupError)) {
      console.error('[helloevents] turnstile:', codes.join(', '));
    }
    return refused('not_success');
  }
  // A token made for another form, or on a site not on our list, does not
  // count. Logged with what Cloudflare reported (an action and a hostname,
  // nothing about the person), since it usually means a setup to fix.
  if (data.action !== action) {
    console.warn(`[helloevents] turnstile: token for action "${String(data.action).slice(0, 32)}", expected "${action}"`);
    return refused('wrong_action');
  }
  let reportedHostname = data.hostname;
  if (reportedHostname === null || reportedHostname === undefined) {
    reportedHostname = '';
  }
  const hostname = String(reportedHostname).toLowerCase();
  if (!hostnames.includes(hostname)) {
    console.warn(`[helloevents] turnstile: token from hostname "${hostname.slice(0, 253)}", not in TURNSTILE_HOSTNAMES`);
    return refused('wrong_hostname');
  }
  return { ok: true };
}

// For a route: reads the token from the parsed JSON body, and answers (and
// returns true) when the request has to stop here. The handler carries on
// unchanged when it returns false.
export async function refusedForTurnstile(request, response, body, action) {
  let token;
  if (body !== null && body !== undefined) {
    token = body[TOKEN_FIELD];
  }
  const result = await verifyTurnstile(request, token, action);
  if (result.ok) {
    return false;
  }
  fail(response, result.status, result.error);
  return true;
}
