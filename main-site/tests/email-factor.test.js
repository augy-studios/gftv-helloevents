// Email as a backup second step and a way to reset a password
// (migrations/028), end to end against the in-memory database, with a
// recorder in place of Resend.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.RESEND_API_KEY = 're_test_key';
process.env.EMAIL_FROM = 'GFTV HelloEvents <no-reply@events.globalfurry.tv>';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const { maskEmail } = await import('../api/_lib/email-factor.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const recover = await route('auth/recover');
const security = await route('me/security');
const sessionRoute = await route('auth/session');

const PASSWORD = 'correct horse battery';
const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let db;
let emails;
let resendStatus;

globalThis.fetch = async (url, init = {}) => {
  if (String(url) === 'https://api.resend.com/emails') {
    emails.push({ headers: init.headers, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'email-1' }), { status: resendStatus });
  }
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  emails = [];
  resendStatus = 200;
  process.env.RESEND_API_KEY = 're_test_key';
});

const lastEmail = () => emails.at(-1);
const codeIn = (email) => email.text.match(/Code: (\d{6})/)[1];
const linkIn = (email, path) => email.text.match(new RegExp(`${path.replace(/[?#]/g, '\\$&')}([A-Za-z0-9_-]+)`))[1];
const account = (username) => db.table('gftvevents_accounts').find((row) => row.username === username);

// A signed-up member, signed in, in their own browser.
async function member(username = 'otter') {
  const b = browser();
  const r = await b.call(signup, { method: 'POST', body: { username, displayName: 'Otter Pup', email: `${username}@example.com`, password: PASSWORD, country: 'SG', agree: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

// Confirms the signed-in account's email with the emailed code.
async function confirmEmail(b) {
  const started = await b.call(security, { method: 'POST', body: { action: 'email-start', password: PASSWORD } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const confirmed = await b.call(security, { method: 'POST', body: { action: 'email-confirm', setup: started.json.setup, code: codeIn(lastEmail()) } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  return confirmed.json;
}

// Turns 2FA on with an authenticator; returns its secret.
async function addAuthenticator(b) {
  const started = await b.call(security, { method: 'POST', body: { action: 'totp-start', password: PASSWORD } });
  await b.call(security, { method: 'POST', body: { action: 'totp-finish', setup: started.json.setup, code: totpAt(started.json.secret) } });
  return started.json.secret;
}

test('an address is masked, never shown whole', () => {
  assert.equal(maskEmail('otter@example.com'), 'o***r@example.com');
  assert.equal(maskEmail('ab@example.com'), 'a***@example.com');
  assert.equal(maskEmail(null), null);
});

test('confirming the address: a code by email, then the Security section shows it confirmed and masked', async () => {
  const b = await member();
  const before = await b.call(security);
  assert.deepEqual(before.json.emailCodes, { available: true, confirmed: false, address: 'o***r@example.com' });

  const started = await b.call(security, { method: 'POST', body: { action: 'email-start', password: 'wrong password' } });
  assert.equal(started.json.error, 'password_wrong');
  assert.equal(emails.length, 0);

  const sent = await b.call(security, { method: 'POST', body: { action: 'email-start', password: PASSWORD } });
  assert.deepEqual(Object.keys(sent.json).sort(), ['ok', 'setup']);
  const email = lastEmail();
  assert.deepEqual(email.to, ['otter@example.com']);
  assert.equal(email.from, 'GFTV HelloEvents <no-reply@events.globalfurry.tv>');
  assert.equal(email.headers.authorization, 'Bearer re_test_key');
  assert.match(email.subject, /^Confirm your email address: \d{6}$/);
  assert.match(email.text, /\/account\?emailConfirm=[A-Za-z0-9_-]+#security/);

  const wrong = await b.call(security, { method: 'POST', body: { action: 'email-confirm', setup: sent.json.setup, code: '000000' === codeIn(email) ? '111111' : '000000' } });
  assert.equal(wrong.json.error, 'code_wrong');
  const done = await b.call(security, { method: 'POST', body: { action: 'email-confirm', setup: sent.json.setup, code: codeIn(email) } });
  assert.deepEqual(done.json.emailCodes, { available: true, confirmed: true, address: 'o***r@example.com' });
  assert.ok(account('otter').email_verified_at);

  const removed = await b.call(security, { method: 'POST', body: { action: 'email-remove', password: PASSWORD } });
  assert.equal(removed.json.emailCodes.confirmed, false);
});

test('the confirming link works only while signed in to the same account', async () => {
  const b = await member();
  await b.call(security, { method: 'POST', body: { action: 'email-start', password: PASSWORD } });
  const link = linkIn(lastEmail(), '/account?emailConfirm=');
  assert.equal((await browser().call(security, { method: 'POST', body: { action: 'email-confirm', link } })).status, 401);
  const fox = await member('fox');
  assert.equal((await fox.call(security, { method: 'POST', body: { action: 'email-confirm', link } })).json.error, 'email_link_expired');
  const done = await b.call(security, { method: 'POST', body: { action: 'email-confirm', link } });
  assert.equal(done.json.emailCodes.confirmed, true);
});

test('email never turns 2FA on by itself: a confirmed address alone, and the password is still the whole sign-in', async () => {
  const b = await member();
  await confirmEmail(b);
  const first = await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assert.equal(first.json.step, 'done');
});

test('with 2FA on, an emailed code is a second step, and it works on any device', async () => {
  const b = await member();
  await addAuthenticator(b);
  await confirmEmail(b);

  const phone = browser();
  const first = await phone.call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assert.equal(first.json.step, 'verify');
  assert.equal(first.json.methods.emailCodes, true);
  const sent = await phone.call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'email-send' } });
  assert.deepEqual(sent.json, { ok: true, sent: true });
  assert.match(lastEmail().subject, /^Your sign-in code: \d{6}$/);
  const code = codeIn(lastEmail());

  const wrong = await phone.call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'email', code: code === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.json.error, 'code_wrong');
  const done = await phone.call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'email', code } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await phone.call(sessionRoute)).json.signedIn, true);
  assert.equal(db.table('gftvevents_sessions').at(-1).factor, 'email');
});

test('the emailed sign-in link signs in only the browser that asked for it, once', async () => {
  const b = await member();
  await addAuthenticator(b);
  await confirmEmail(b);

  const laptop = browser();
  const first = await laptop.call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  await laptop.call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'email-send' } });
  const link = linkIn(lastEmail(), '/login#email=');

  // A mail scanner, or the link opened on a phone.
  const elsewhere = browser();
  const refused = await elsewhere.call(verify, { method: 'POST', body: { method: 'email-link', link } });
  assert.equal(refused.json.error, 'email_link_other_browser');
  assert.equal((await elsewhere.call(sessionRoute)).json.signedIn, false);

  const done = await laptop.call(verify, { method: 'POST', body: { method: 'email-link', link } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await laptop.call(sessionRoute)).json.signedIn, true);
  assert.equal((await laptop.call(verify, { method: 'POST', body: { method: 'email-link', link } })).json.error, 'email_link_expired');
});

test('an address not confirmed, email not set up, or Resend refusing: no email way', async () => {
  const b = await member();
  await addAuthenticator(b);
  const first = await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assert.equal(first.json.methods.emailCodes, false);
  assert.equal((await browser().call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'email-send' } })).json.error, 'email_not_confirmed');

  await confirmEmail(b);
  resendStatus = 429;
  const second = await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  const failed = await browser().call(verify, { method: 'POST', body: { challenge: second.json.challenge, method: 'email-send' } });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error, 'email_send_failed');

  delete process.env.RESEND_API_KEY;
  const third = await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assert.equal(third.json.methods.emailCodes, false);
  assert.equal((await b.call(security)).json.emailCodes.available, false);
  assert.equal((await b.call(security, { method: 'POST', body: { action: 'email-start', password: PASSWORD } })).json.error, 'email_off');
});

test('a reset by email: the code alone without 2FA, and a notice once it is done', async () => {
  const b = await member();
  await confirmEmail(b);
  const tab = browser();
  const start = await tab.call(recover, { method: 'POST', body: { action: 'start', identifier: 'otter' } });
  assert.equal(start.json.emailCodes, true);
  assert.equal(start.json.factor.required, false);
  await tab.call(recover, { method: 'POST', body: { action: 'send', channel: 'email', challenge: start.json.challenge } });
  assert.match(lastEmail().subject, /^Your password reset code: \d{6}$/);
  const done = await tab.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, method: 'email', emailCode: codeIn(lastEmail()), newPassword: 'a brand new secret' } });
  assert.deepEqual(done.json, { ok: true, signedIn: true });
  assert.equal(await bcrypt.compare('a brand new secret', account('otter').password_hash), true);
  assert.equal(lastEmail().subject, 'Your password was reset');
});

test('a reset by the emailed link: in the same browser it carries on with a new challenge, and 2FA is still needed', async () => {
  const b = await member();
  const secret = await addAuthenticator(b);
  await confirmEmail(b);
  const tab = browser();
  const start = await tab.call(recover, { method: 'POST', body: { action: 'start', identifier: 'otter' } });
  assert.equal(start.json.factor.required, true);
  await tab.call(recover, { method: 'POST', body: { action: 'send', channel: 'email', challenge: start.json.challenge } });
  const link = linkIn(lastEmail(), '/reset#email=');

  assert.equal((await browser().call(recover, { method: 'POST', body: { action: 'email-link', link } })).json.error, 'email_link_other_browser');
  const followed = await tab.call(recover, { method: 'POST', body: { action: 'email-link', link } });
  assert.equal(followed.status, 200, JSON.stringify(followed.json));
  assert.equal(followed.json.emailVerified, true);
  assert.notEqual(followed.json.challenge, start.json.challenge);
  assert.equal((await tab.call(recover, { method: 'POST', body: { action: 'send', channel: 'email', challenge: start.json.challenge } })).json.error, 'challenge_expired', 'the old challenge stops working');

  const challenge = followed.json.challenge;
  const noFactor = await tab.call(recover, { method: 'POST', body: { action: 'finish', challenge, method: 'email', newPassword: 'a brand new secret' } });
  assert.equal(noFactor.json.error, 'code_wrong');
  const done = await tab.call(recover, { method: 'POST', body: { action: 'finish', challenge, method: 'email', factor: 'totp', code: totpAt(secret), newPassword: 'a brand new secret' } });
  assert.deepEqual(done.json, { ok: true, signedIn: true });
});

test('a staff member\'s confirmation stops holding once their email changes on gftv.asia', async () => {
  await db.from('gftvhello_users').insert({
    username: 'boss', display_name: 'Boss', email: 'boss@gftv.example', password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true, is_admin: true, totp_secret: SHARED_SECRET,
  });
  const b = browser();
  const first = await b.call(login, { method: 'POST', body: { identifier: 'boss', password: PASSWORD } });
  assert.equal(first.json.methods.emailCodes, false);
  await b.call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  const confirmed = await confirmEmail(b);
  assert.equal(confirmed.emailCodes.address, 'b***s@gftv.example');
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'boss', password: PASSWORD } })).json.methods.emailCodes, true);

  db.table('gftvhello_users')[0].email = 'boss@new.example';
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'boss', password: PASSWORD } })).json.methods.emailCodes, false);
  assert.equal((await b.call(security)).json.emailCodes.confirmed, false);
});
