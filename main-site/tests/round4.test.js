// Round 4 of help desk #7, end to end against the in-memory database: reset
// with a backup code, admin one-time reset codes, venue sign-up allowances,
// the display name filter with the admins' own list, and backup codes for
// whoever turns 2FA on.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser, leaks } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.CRON_SECRET = 'cron-test';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const { forgetNameFilters } = await import('../api/_lib/name-filter.js');
const { backupCodesForNewFactor } = await import('../api/_lib/factors.js');
const { loadAccount } = await import('../api/_lib/users.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const recover = await route('auth/recover');
const sessionRoute = await route('auth/session');
const security = await route('me/security');
const profile = await route('me/profile');
const admin = await route('manage/admin');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  forgetNameFilters();
});

const join = (over = {}) => ({ username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, agree: true, ...over });

// A browser on its own connection unless ip is given.
let nextIp = 1;
function on(ip = `198.51.100.${nextIp++}`) {
  const b = browser();
  const call = b.call;
  b.call = (handler, opts = {}) => call(handler, { ip, ...opts });
  return b;
}

async function member(over = {}, b = on()) {
  const r = await b.call(signup, { method: 'POST', body: join(over) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

async function staff(username, over = {}, b = on()) {
  await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@gftv.example`, password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true, totp_secret: SHARED_SECRET, ...over,
  });
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return b;
}

async function withTotp(b) {
  const start = await b.call(security, { method: 'POST', body: { action: 'totp-start', password: PASSWORD } });
  const done = await b.call(security, { method: 'POST', body: { action: 'totp-finish', setup: start.json.setup, code: totpAt(start.json.secret) } });
  return { secret: start.json.secret, codes: done.json.codes };
}

const startReset = async (identifier) => (await on().call(recover, { method: 'POST', body: { action: 'start', identifier } })).json;
const finish = (body) => on().call(recover, { method: 'POST', body: { action: 'finish', newPassword: 'a brand new secret', ...body } });
const canSignIn = async (password) => (await on().call(login, { method: 'POST', body: { identifier: 'otter', password } })).json;

// ---------------------------------------------------------------------------
// Reset with a backup code
// ---------------------------------------------------------------------------

test('a member with 2FA resets a forgotten password with one backup code, once', async () => {
  const m = await member();
  const { codes } = await withTotp(m);
  const r = await startReset('otter');
  assert.equal(r.backup, true);
  assert.equal(r.telegram, false);
  assert.equal((await finish({ challenge: r.challenge, method: 'backup', code: 'aaaaa-bbbbb' })).json.error, 'code_wrong');
  const done = await finish({ challenge: r.challenge, method: 'backup', code: codes[0] });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.signedIn, true);
  assert.equal((await m.call(sessionRoute)).json.signedIn, false, 'other devices signed out');
  assert.equal((await canSignIn(PASSWORD)).error, 'invalid_credentials');
  assert.equal((await canSignIn('a brand new secret')).step, 'verify', '2FA stays on');
  // The code is spent.
  const again = await startReset('otter');
  assert.equal((await finish({ challenge: again.challenge, method: 'backup', code: codes[0], newPassword: 'yet another secret' })).json.error, 'code_wrong');
});

test('without 2FA a backup code is not a way in', async () => {
  await member();
  const r = await startReset('otter');
  assert.equal(r.backup, false);
  assert.equal((await finish({ challenge: r.challenge, method: 'backup', code: 'aaaaa-bbbbb' })).json.error, 'code_wrong');
});

// ---------------------------------------------------------------------------
// Admin reset codes
// ---------------------------------------------------------------------------

test('only admins make reset codes; a code works once, and a new one cancels the last', async () => {
  await member();
  const ed = await staff('editor', { is_editor: true });
  assert.equal((await ed.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'otter' } })).json.error, 'admin_only');
  const ad = await staff('boss', { is_admin: true });
  assert.equal((await ad.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'nobody' } })).json.error, 'account_not_found');
  assert.equal((await ad.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'editor' } })).json.error, 'account_not_found', 'not for staff accounts');

  const first = (await ad.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'otter' } })).json;
  assert.match(first.code, /^[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}$/);
  const second = (await ad.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'otter' } })).json;
  // Stored as a hash only.
  const row = db.table('gftvevents_password_resets')[0];
  assert.equal(db.table('gftvevents_password_resets').length, 1);
  assert.equal(JSON.stringify(row).includes(second.code.replace(/-/g, '')), false);

  const r = await startReset('otter');
  assert.equal((await finish({ challenge: r.challenge, method: 'staff-code', resetCode: first.code })).json.error, 'code_wrong', 'the cancelled one');
  const done = await finish({ challenge: r.challenge, method: 'staff-code', resetCode: second.code.toUpperCase() });
  assert.equal(done.status, 200);
  assert.equal(done.json.signedIn, true, 'no 2FA, so signed straight in');
  assert.equal((await canSignIn('a brand new secret')).step, 'done');

  const r2 = await startReset('otter');
  assert.equal((await finish({ challenge: r2.challenge, method: 'staff-code', resetCode: second.code, newPassword: 'another one again' })).json.error, 'code_wrong', 'used once');
  assert.ok(db.table('gftvevents_audit_logs').some((a) => a.action === 'admin.password_reset_issued'));
});

test('an expired reset code fails; on a 2FA account a code only sets the password', async () => {
  const m = await member();
  await withTotp(m);
  const ad = await staff('boss', { is_admin: true });
  const { code } = (await ad.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'otter' } })).json;

  db.table('gftvevents_password_resets')[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await startReset('otter');
  assert.equal((await finish({ challenge: r.challenge, method: 'staff-code', resetCode: code })).json.error, 'code_wrong');

  db.table('gftvevents_password_resets')[0].expires_at = new Date(Date.now() + 3600_000).toISOString();
  const b = on();
  const r2 = (await b.call(recover, { method: 'POST', body: { action: 'start', identifier: 'otter' } })).json;
  const done = await b.call(recover, { method: 'POST', body: { action: 'finish', challenge: r2.challenge, method: 'staff-code', resetCode: code, newPassword: 'a brand new secret' } });
  assert.equal(done.json.signedIn, false);
  assert.equal(done.headers['set-cookie'], undefined, 'no session without the second step');
  assert.equal((await canSignIn('a brand new secret')).step, 'verify');
});

// ---------------------------------------------------------------------------
// Venue sign-up allowances
// ---------------------------------------------------------------------------

test('a staff member raises the sign-up limit for the venue connection, for a while', async () => {
  const venue = '203.0.113.50';
  const tryJoin = (n) => on(venue).call(signup, { method: 'POST', body: join({ username: `guest${n}`, email: `guest${n}@example.com` }) });
  for (let n = 1; n <= 5; n += 1) assert.equal((await tryJoin(n)).status, 200);
  assert.equal((await tryJoin(6)).status, 429, 'the normal limit');

  // A member cannot; an editor on the venue Wi-Fi can.
  const m = await member({ username: 'visitor', email: 'visitor@example.com' }, on('198.51.100.200'));
  assert.equal((await m.call(admin, { method: 'POST', body: { action: 'allowance-grant', hours: 4, perHour: 100 } })).status, 403);
  const ed = await staff('editor', { is_editor: true }, on(venue));
  assert.equal((await ed.call(admin, { method: 'POST', body: { action: 'allowance-grant', hours: 24, perHour: 100 } })).json.field, 'hours');
  assert.equal((await ed.call(admin, { method: 'POST', body: { action: 'allowance-grant', hours: 4, perHour: 5000 } })).json.field, 'perHour');
  const granted = await ed.call(admin, { method: 'POST', body: { action: 'allowance-grant', hours: 4, perHour: 100, label: 'Furmeet hall' } });
  assert.equal(granted.status, 200);
  assert.equal(granted.json.here, true);
  assert.equal(granted.json.allowances[0].by, 'editor');
  assert.equal(JSON.stringify(granted.json).includes('ip_hash'), false);
  assert.equal(JSON.stringify(granted.json).includes(db.table('gftvevents_signup_allowances')[0].ip_hash), false, 'the hash is never sent');
  assert.deepEqual(leaks(granted.json), []);

  for (let n = 6; n <= 12; n += 1) assert.equal((await tryJoin(n)).status, 200, `sign-up ${n} at the venue`);
  // Another connection is not affected.
  for (let n = 0; n < 5; n += 1) await on('192.0.2.9').call(signup, { method: 'POST', body: join({ username: `else${n}`, email: `else${n}@example.com` }) });
  assert.equal((await on('192.0.2.9').call(signup, { method: 'POST', body: join({ username: 'else9', email: 'else9@example.com' }) })).status, 429);

  // Ending it restores the normal limit.
  await ed.call(admin, { method: 'POST', body: { action: 'allowance-revoke', id: granted.json.allowances[0].id } });
  assert.equal((await tryJoin(13)).status, 429);
  assert.ok(db.table('gftvevents_audit_logs').some((a) => a.action === 'admin.signup_allowance_granted'));
  assert.ok(db.table('gftvevents_audit_logs').some((a) => a.action === 'admin.signup_allowance_revoked'));
});

test('an expired allowance no longer counts', async () => {
  const venue = '203.0.113.60';
  const ed = await staff('editor', { is_editor: true }, on(venue));
  await ed.call(admin, { method: 'POST', body: { action: 'allowance-grant', hours: 2, perHour: 50 } });
  db.table('gftvevents_signup_allowances')[0].expires_at = new Date(Date.now() - 1000).toISOString();
  for (let n = 1; n <= 5; n += 1) await on(venue).call(signup, { method: 'POST', body: join({ username: `late${n}`, email: `late${n}@example.com` }) });
  assert.equal((await on(venue).call(signup, { method: 'POST', body: join({ username: 'late6', email: 'late6@example.com' }) })).status, 429);
});

// ---------------------------------------------------------------------------
// Display name filter
// ---------------------------------------------------------------------------

test('names that look like staff are refused at sign-up and on a display name change', async () => {
  assert.equal((await on().call(signup, { method: 'POST', body: join({ displayName: 'GFTV 5taff' }) })).json.error, 'display_name_reserved');
  assert.equal((await on().call(signup, { method: 'POST', body: join({ displayName: 'Оfficial Otter' }) })).json.error, 'display_name_reserved', 'Cyrillic O');
  assert.equal((await on().call(signup, { method: 'POST', body: join({ username: 'adm1n_otter' }) })).json.error, 'username_reserved');
  const m = await member();
  assert.equal((await m.call(profile, { method: 'POST', body: { displayName: 'M o d e r a t o r' } })).json.error, 'display_name_reserved');
  const ok = await m.call(profile, { method: 'POST', body: { displayName: '  Sleepy   Otter ' } });
  assert.equal(ok.json.user.displayName, 'Sleepy Otter');
  const s = await staff('teamfox');
  assert.equal((await s.call(profile, { method: 'POST', body: { displayName: 'Anything' } })).json.error, 'staff_account');
});

test('admins keep their own list; existing names that match are flagged, not changed', async () => {
  await member({ username: 'pride_otter', displayName: 'Pride Guard Otter', email: 'p@example.com' });
  const ad = await staff('boss', { is_admin: true });
  const ed = await staff('editor', { is_editor: true });
  assert.equal((await ed.call(admin, { method: 'POST', body: { action: 'filter-add', term: 'prideguard' } })).json.error, 'admin_only');
  const editorView = (await ed.call(admin)).json;
  assert.equal('filters' in editorView, false, 'editors see allowances only');

  assert.equal((await ad.call(admin, { method: 'POST', body: { action: 'filter-add', term: 'x' } })).json.error, 'filter_invalid');
  const added = await ad.call(admin, { method: 'POST', body: { action: 'filter-add', term: 'Pr1de Gu4rd' } });
  assert.deepEqual(added.json.filters.map((f) => f.term), ['prideguard']);
  assert.deepEqual(added.json.flagged.map((f) => [f.username, f.term]), [['pride_otter', 'prideguard']]);
  assert.equal(JSON.stringify(added.json).includes('p@example.com'), false);
  assert.equal(db.table('gftvevents_accounts').find((a) => a.username === 'pride_otter').display_name, 'Pride Guard Otter', 'left as it was');

  // New names are refused straight away (the cache is cleared on change).
  assert.equal((await on().call(signup, { method: 'POST', body: join({ username: 'newbie', email: 'n@example.com', displayName: 'PRIDE-GUARD' }) })).json.error, 'display_name_reserved');
  const view = (await ad.call(admin)).json;
  assert.ok(view.builtIn.includes('staff'));
  await ad.call(admin, { method: 'POST', body: { action: 'filter-remove', id: view.filters[0].id } });
  assert.equal((await on().call(signup, { method: 'POST', body: join({ username: 'newbie', email: 'n@example.com', displayName: 'PRIDE-GUARD' }) })).status, 200);
});

// ---------------------------------------------------------------------------
// Backup codes for whoever turns 2FA on
// ---------------------------------------------------------------------------

test('the first second factor comes with backup codes, whichever kind it is', async () => {
  await member();
  const account = await loadAccount(db.table('gftvevents_accounts')[0].id);
  // What the passkey path calls once a passkey is saved.
  const codes = await backupCodesForNewFactor(account);
  assert.equal(codes.length, 10);
  assert.equal(await backupCodesForNewFactor(account), null, 'not again while codes are left');
  const m = await member({ username: 'badger', email: 'badger@example.com' });
  const { codes: totpCodes } = await withTotp(m);
  assert.equal(totpCodes.length, 10);
});
