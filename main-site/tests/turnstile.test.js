// Help desk #10: Cloudflare Turnstile on sign-in, sign-up and starting a
// password reset. Cloudflare's siteverify is replaced by a recorder; the
// routes run against the in-memory database. Cloudflare's public test secret
// (always passes) stands in for the real one, which never appears here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.CRON_SECRET = 'cron-test';
const TEST_SECRET = '1x0000000000000000000000000000000AA';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { forgetNameFilters } = await import('../api/_lib/name-filter.js');
const turnstile = await import('../api/_lib/turnstile.js');
const { verifyTurnstile, turnstileSiteKey, allowedHostnames, SITE_KEY, TOKEN_FIELD } = turnstile;
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const recover = await route('auth/recover');
const config = await route('public/config');

const PASSWORD = 'correct horse battery';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
let calls;
// What siteverify answers next: an object (sent as JSON), a Response, or a
// function that throws.
let answer;

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (typeof answer === 'function') return answer(url, init);
  if (answer instanceof Response) return answer;
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const passFor = (action, hostname = 'events.globalfurry.tv') => ({
  success: true, action, hostname, challenge_ts: new Date().toISOString(), 'error-codes': [],
});

const ENV = ['TURNSTILE_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAMES', 'TURNSTILE_SITE_KEY', 'VERCEL_ENV'];
let logged;
const original = { warn: console.warn, error: console.error };

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  process.env.TURNSTILE_SECRET = TEST_SECRET;
  calls = [];
  answer = passFor('login');
  logged = [];
  console.warn = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  const db = createFakeDb();
  useTestClient(db);
  forgetNameFilters();
});

afterEach(() => {
  console.warn = original.warn;
  console.error = original.error;
});

const req = (ip = '203.0.113.9') => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } });

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

test('a passed token for the right action and hostname is accepted, sent form-encoded with the IP', async () => {
  const result = await verifyTurnstile(req(), TOKEN, 'login');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SITEVERIFY);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'siteverify has a timeout');
  const sent = new URLSearchParams(String(calls[0].init.body));
  assert.equal(sent.get('secret'), TEST_SECRET);
  assert.equal(sent.get('response'), TOKEN);
  assert.equal(sent.get('remoteip'), '203.0.113.9');
});

test('a token made for another form is refused', async () => {
  answer = passFor('signup');
  const result = await verifyTurnstile(req(), TOKEN, 'login');
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'human_check_failed');
  assert.equal(result.reason, 'wrong_action');
});

test('a token made on another hostname is refused', async () => {
  answer = passFor('login', 'evil.example');
  const result = await verifyTurnstile(req(), TOKEN, 'login');
  assert.equal(result.reason, 'wrong_hostname');
  assert.equal(result.status, 403);
});

test('TURNSTILE_HOSTNAMES is the allowlist, comma-separated, and SITE_URL is the default', async () => {
  assert.deepEqual(allowedHostnames(), ['events.globalfurry.tv']);
  process.env.TURNSTILE_HOSTNAMES = ' events.globalfurry.tv , Preview.Example.app ,';
  assert.deepEqual(allowedHostnames(), ['events.globalfurry.tv', 'preview.example.app']);
  answer = passFor('login', 'preview.example.app');
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).ok, true);
});

test('production never accepts localhost, whatever TURNSTILE_HOSTNAMES says', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.TURNSTILE_HOSTNAMES = 'events.globalfurry.tv,localhost,127.0.0.1';
  assert.deepEqual(allowedHostnames(), ['events.globalfurry.tv']);
  answer = passFor('login', 'localhost');
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).reason, 'wrong_hostname');
  // Only local hostnames left: refused before Cloudflare is asked.
  process.env.TURNSTILE_HOSTNAMES = 'localhost';
  calls = [];
  const result = await verifyTurnstile(req(), TOKEN, 'login');
  assert.equal(result.status, 503);
  assert.equal(result.error, 'human_check_unavailable');
  assert.equal(calls.length, 0);
});

test('a failed check is refused, and a setup error is logged without the secret', async () => {
  answer = { success: false, 'error-codes': ['invalid-input-response'] };
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).reason, 'not_success');
  answer = { success: false, 'error-codes': ['invalid-input-secret'] };
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).reason, 'not_success');
  assert.ok(logged.some((line) => line.includes('invalid-input-secret')));
  // success must be exactly true.
  answer = { ...passFor('login'), success: 'true' };
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).ok, false);
});

test('Cloudflare not answering, answering an HTTP error, or timing out is a refusal', async () => {
  answer = new Response('busy', { status: 502 });
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).reason, 'unreachable');
  answer = () => { throw new TypeError('fetch failed'); };
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).reason, 'unreachable');
  // What fetch throws when AbortSignal.timeout fires.
  answer = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const result = await verifyTurnstile(req(), TOKEN, 'login');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.status, 403);
  assert.ok(logged.some((line) => line.includes('timed out')));
});

test('a missing, empty, non-string or over-long token is refused without asking Cloudflare', async () => {
  for (const token of [undefined, null, '', 42, { token: TOKEN }, 'x'.repeat(2049)]) {
    const result = await verifyTurnstile(req(), token, 'login');
    assert.equal(result.reason, 'bad_token', String(token));
  }
  assert.equal(calls.length, 0);
  assert.equal((await verifyTurnstile(req(), 'x'.repeat(2048), 'login')).ok, true);
});

test('without the secret: production fails closed, anywhere else skips with one warning', async () => {
  delete process.env.TURNSTILE_SECRET;
  process.env.VERCEL_ENV = 'production';
  const closed = await verifyTurnstile(req(), TOKEN, 'login');
  assert.equal(closed.status, 503);
  assert.equal(closed.error, 'human_check_unavailable');
  assert.equal(turnstileSiteKey(), SITE_KEY, 'production still draws the widget');

  process.env.VERCEL_ENV = 'preview';
  assert.equal((await verifyTurnstile(req(), undefined, 'login')).skipped, true);
  assert.equal((await verifyTurnstile(req(), undefined, 'login')).skipped, true);
  assert.equal(turnstileSiteKey(), null, 'no widget where nothing is checked');
  assert.equal(calls.length, 0);
  assert.equal(logged.filter((line) => line.includes('check is skipped')).length, 1);
});

test('the linktree name TURNSTILE_SECRET_KEY works too; TURNSTILE_SITE_KEY overrides the built-in key', async () => {
  delete process.env.TURNSTILE_SECRET;
  process.env.TURNSTILE_SECRET_KEY = TEST_SECRET;
  assert.equal((await verifyTurnstile(req(), TOKEN, 'login')).ok, true);
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get('secret'), TEST_SECRET);
  assert.equal(turnstileSiteKey(), '0x4AAAAAAFoBqV14BTwQSjRX');
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  assert.equal(turnstileSiteKey(), '1x00000000000000000000AA');
});

test('nothing logged carries the token or the IP address', async () => {
  answer = () => { throw new Error('boom'); };
  await verifyTurnstile(req('198.51.100.77'), TOKEN, 'login');
  answer = { success: false, 'error-codes': ['invalid-input-secret'] };
  await verifyTurnstile(req('198.51.100.77'), TOKEN, 'login');
  assert.ok(logged.length > 0);
  for (const line of logged) {
    assert.ok(!line.includes(TOKEN) && !line.includes('198.51.100.77') && !line.includes(TEST_SECRET), line);
  }
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

const join = (over = {}) => ({ username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, agree: true, ...over });
const post = (b, handler, body) => b.call(handler, { method: 'POST', body });

test('sign-up needs a passed "signup" check; the name filter and the rest still apply after it', async () => {
  const b = browser();
  let r = await post(b, signup, join());
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'human_check_failed');
  assert.equal(calls.length, 0);

  answer = passFor('login');
  r = await post(b, signup, join({ [TOKEN_FIELD]: TOKEN }));
  assert.equal(r.json.error, 'human_check_failed', 'a sign-in token does not open sign-up');

  answer = passFor('signup');
  r = await post(b, signup, join({ username: 'gftvstaff', [TOKEN_FIELD]: TOKEN }));
  assert.equal(r.json.error, 'username_reserved');
  r = await post(b, signup, join({ [TOKEN_FIELD]: TOKEN }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.username, 'otter');
});

test('sign-in needs a passed "login" check before any account is looked up', async () => {
  answer = passFor('signup');
  await post(browser(), signup, join({ [TOKEN_FIELD]: TOKEN }));

  answer = passFor('reset');
  let r = await post(browser(), login, { identifier: 'otter', password: PASSWORD, [TOKEN_FIELD]: TOKEN });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'human_check_failed');

  answer = passFor('login');
  r = await post(browser(), login, { identifier: 'otter', password: 'wrong password!!', [TOKEN_FIELD]: TOKEN });
  assert.equal(r.json.error, 'invalid_credentials');
  r = await post(browser(), login, { identifier: 'otter', password: PASSWORD, [TOKEN_FIELD]: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.step, 'done');
});

test('starting a reset needs a passed "reset" check; the later steps ride on its challenge', async () => {
  answer = passFor('signup');
  await post(browser(), signup, join({ [TOKEN_FIELD]: TOKEN }));

  let r = await post(browser(), recover, { action: 'start', identifier: 'otter' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'human_check_failed');
  assert.equal(r.json.challenge, undefined);

  answer = passFor('reset');
  r = await post(browser(), recover, { action: 'start', identifier: 'otter', [TOKEN_FIELD]: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.found, true);
  assert.ok(r.json.challenge);

  // finish carries no token: the challenge is what it needs.
  calls = [];
  const f = await post(browser(), recover, { action: 'finish', challenge: r.json.challenge, method: 'staff-code', resetCode: 'AAAAA-BBBBB-CCCCC', newPassword: 'a brand new secret' });
  assert.equal(f.json.error, 'code_wrong');
  assert.equal(calls.length, 0);
});

test('production without the secret refuses the forms with a clear, translated error', async () => {
  delete process.env.TURNSTILE_SECRET;
  process.env.VERCEL_ENV = 'production';
  const r = await post(browser(), signup, join({ [TOKEN_FIELD]: TOKEN }));
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'human_check_unavailable');
  const { default: en } = await import('../assets/i18n/en.json', { with: { type: 'json' } });
  for (const code of ['human_check_failed', 'human_check_pending', 'human_check_unavailable']) {
    assert.ok(en[`error.${code}`], `error.${code} is in en.json`);
  }
});

test('the page is handed the site key only when the check runs', async () => {
  let r = await browser().call(config);
  assert.equal(r.json.turnstileSiteKey, SITE_KEY);
  delete process.env.TURNSTILE_SECRET;
  r = await browser().call(config);
  assert.equal(r.json.turnstileSiteKey, null);
});
