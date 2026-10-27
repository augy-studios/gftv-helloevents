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
export const TIMEOUT_MS = 10_000;
// Cloudflare's limit on a token's length.
const MAX_TOKEN = 2048;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let warned = false;

const production = () => process.env.VERCEL_ENV === 'production';

// TURNSTILE_SECRET is Cloudflare's name for it; TURNSTILE_SECRET_KEY, the
// name gftv-linktree uses, is read too, so a value copied from there works.
function secret() {
  return optionalEnv('TURNSTILE_SECRET') || optionalEnv('TURNSTILE_SECRET_KEY');
}

// Checked at all: a secret is set, or this is production (where a missing
// secret refuses instead).
export function turnstileOn() {
  return secret() !== '' || production();
}

// What the page draws the widget with, or null when nothing is checked.
export function turnstileSiteKey() {
  return turnstileOn() ? optionalEnv('TURNSTILE_SITE_KEY', SITE_KEY) : null;
}

// The hostnames a token may come from: TURNSTILE_HOSTNAMES, comma-separated,
// or SITE_URL's hostname when that is blank. Production never accepts
// localhost or 127.0.0.1, whatever the variable says.
export function allowedHostnames() {
  const raw = optionalEnv('TURNSTILE_HOSTNAMES') || new URL(siteUrl()).hostname;
  const list = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return production() ? list.filter((h) => !LOCAL_HOSTS.has(h)) : list;
}

// The check by itself, for the tests and for routes that answer their own
// way: { ok: true } or { ok: false, status, error, reason }. reason is for
// the logs and tests only; the browser gets error alone.
export async function verifyTurnstile(req, token, action) {
  const key = secret();
  if (!key) {
    if (production()) {
      console.error('[helloevents] turnstile: TURNSTILE_SECRET is not set in production; refusing');
      return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'no_secret' };
    }
    if (!warned) console.warn('[helloevents] turnstile: TURNSTILE_SECRET is not set; the check is skipped (not production)');
    warned = true;
    return { ok: true, skipped: true };
  }
  const hostnames = allowedHostnames();
  if (hostnames.length === 0) {
    console.error('[helloevents] turnstile: TURNSTILE_HOSTNAMES has no usable hostname; refusing');
    return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'no_hostnames' };
  }
  const refused = (reason) => ({ ok: false, status: 403, error: 'human_check_failed', reason });
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN) return refused('bad_token');

  let data;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: new URLSearchParams({ secret: key, response: token, remoteip: clientIp(req) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (cause) {
    const why = cause?.name === 'TimeoutError' ? 'timed out' : cause?.message ?? String(cause);
    console.warn('[helloevents] turnstile siteverify:', why);
    return refused(cause?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
  }

  if (data?.success !== true) {
    const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'].map(String) : [];
    // Our own setup is wrong (a bad secret, say): worth an error in the logs.
    if (codes.some((c) => c.includes('secret') || c === 'internal-error')) {
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
  const hostname = String(data.hostname ?? '').toLowerCase();
  if (!hostnames.includes(hostname)) {
    console.warn(`[helloevents] turnstile: token from hostname "${hostname.slice(0, 253)}", not in TURNSTILE_HOSTNAMES`);
    return refused('wrong_hostname');
  }
  return { ok: true };
}

// For a route: reads the token from the parsed JSON body, and answers (and
// returns true) when the request has to stop here. The handler carries on
// unchanged when it returns false.
export async function refusedForTurnstile(req, res, body, action) {
  const result = await verifyTurnstile(req, body?.[TOKEN_FIELD], action);
  if (result.ok) return false;
  fail(res, result.status, result.error);
  return true;
}
