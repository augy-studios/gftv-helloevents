// Public accounts, notifications and cover pictures (help desk #7, round 3),
// end to end against the in-memory database, a fake Redis, a recorder in
// place of Telegram, and a recorder in place of the push services.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { browser, leaks } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_BOT_USERNAME = 'HelloEventsTestBot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.CRON_SECRET = 'cron-test';
process.env.VAPID_PUBLIC_KEY = 'B'.repeat(87);
process.env.VAPID_PRIVATE_KEY = 'test-private-key';
process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { resetLocaleColumn } = await import('../api/_lib/locale-column.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { useTestPushSender } = await import('../api/_lib/push.js');
const { settle, changeNotice, flushDueChanges } = await import('../api/_lib/notify.js');
// Change notices go out as soon as the save's background work runs; the
// batching test below sets its own short wait.
changeNotice.waitMs = 0;
changeNotice.graceMs = 0;
const { totpAt } = await import('../api/_lib/totp.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const recover = await route('auth/recover');
const sessionRoute = await route('auth/session');
const rsvp = await route('events/rsvp');
const detail = await route('events/detail');
const manage = await route('manage/events');
const cover = await route('manage/cover');
const security = await route('me/security');
const notifications = await route('me/notifications');
const profile = await route('me/profile');
const webhook = await route('telegram/webhook');
const cronNotify = await route('cron/notify');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const HOOK = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' };
let db;
let redisFake;
let sent;
let pushes;

globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  redisFake = createFakeRedis();
  useTestRedis(redisFake);
  sent = [];
  pushes = [];
  useTestPushSender(async (sub, body) => {
    if (sub.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
  });
});

const join = (over = {}) => ({ username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, country: 'SG', agree: true, ...over });

async function member(b = browser(), over = {}) {
  const r = await b.call(signup, { method: 'POST', body: join(over) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

async function staff(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username,
    display_name: username,
    email: `${username}@gftv.example`,
    password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true,
    totp_secret: SHARED_SECRET,
    ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  return b;
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: over.slug ?? `event-${db.table('gftvevents_events').length + 1}`,
    title: 'Furmeet',
    status: 'published',
    // Whole minutes, as the edit form saves them.
    starts_at: new Date(Math.floor((Date.now() + 7 * 86400_000) / 60_000) * 60_000).toISOString(),
    ends_at: null,
    announced_at: new Date().toISOString(),
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

async function linkTelegram(b, chatId = 777) {
  const link = await b.call(security, { method: 'POST', body: { action: 'telegram-link' } });
  const token = new URL(link.json.url).searchParams.get('start');
  await browser().call(webhook, {
    method: 'POST',
    headers: HOOK,
    body: { message: { chat: { id: chatId, type: 'private' }, from: { username: 'otterchat' }, text: `/start ${token}` } },
  });
}

const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/device-1') => ({ endpoint, keys: { p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) } });
const webp = async (w = 1600, h = 900) => `data:image/webp;base64,${(await sharp({ create: { width: w, height: h, channels: 3, background: '#ff8a4c' } }).webp().toBuffer()).toString('base64')}`;

// ---------------------------------------------------------------------------
// Sign-up and sign-in
// ---------------------------------------------------------------------------

test('signing up makes a public account with a bcrypt cost 12 password, and signs in', async () => {
  const b = browser();
  const r = await b.call(signup, { method: 'POST', body: join({ username: 'Otter', email: ' Otter@Example.com ' }) });
  assert.equal(r.status, 200);
  // The answer is only ok (help desk #18); the session says who it is.
  assert.deepEqual((await b.call(sessionRoute)).json.user, { username: 'otter', displayName: 'Otter', avatarUrl: null, kind: 'public', role: 'member', canManage: false, editsEvents: false, country: 'SG', personal: { legalName: null, dateOfBirth: null, emergencyName: null, emergencyPhone: null }, idVerified: [], locale: null });
  assert.deepEqual(leaks(r.json), []);
  const row = db.table('gftvevents_accounts')[0];
  assert.equal(row.kind, 'public');
  assert.equal(row.email, 'otter@example.com');
  assert.match(row.password_hash, /^\$2[aby]\$12\$/);
  assert.ok(row.terms_accepted_at);
  assert.equal((await b.call(sessionRoute)).json.user.kind, 'public');
  assert.equal(db.table('gftvevents_sessions')[0].factor, 'password');
});

test('sign-up refuses taken, reserved and staff names and addresses, and needs the terms', async () => {
  await member();
  // Each try from its own connection, so the sign-up rate limit stays out of it.
  let n = 10;
  const fresh = () => { const b = browser(); const call = b.call; b.call = (h, o) => call(h, { ip: `198.51.100.${n++}`, ...o }); return b; };
  const browserFor = fresh;
  assert.equal((await browserFor().call(signup, { method: 'POST', body: join() })).json.error, 'username_taken');
  assert.equal((await browserFor().call(signup, { method: 'POST', body: join({ username: 'otter2' }) })).json.error, 'email_taken');
  await db.from('gftvhello_users').insert({ username: 'teamfox', display_name: 'Team Fox', email: 'team@gftv.example', password_hash: 'x', is_approved: true });
  assert.equal((await browserFor().call(signup, { method: 'POST', body: join({ username: 'teamfox', email: 'a@example.com' }) })).json.error, 'username_taken');
  assert.equal((await browserFor().call(signup, { method: 'POST', body: join({ username: 'fresh', email: 'team@gftv.example' }) })).json.error, 'email_taken');
  assert.equal((await browserFor().call(signup, { method: 'POST', body: join({ username: 'gftv_staff', email: 'b@example.com' }) })).json.error, 'username_reserved');
  assert.equal((await browserFor().call(signup, { method: 'POST', body: join({ username: 'newone', email: 'c@example.com', agree: false }) })).json.error, 'terms_required');
});

test('sign-up has no limit per connection, so a venue on one Wi-Fi can all sign up (migrations/027)', async () => {
  for (let i = 0; i < 12; i += 1) {
    const joined = await browser().call(signup, { method: 'POST', body: join({ username: `u${i}xx`, email: `${i}@example.com` }) });
    assert.equal(joined.status, 200, `sign-up ${i + 1} from one connection`);
  }
});

test('sign-up is still rate limited per email address', async () => {
  for (let i = 0; i < 5; i += 1) await browser().call(signup, { method: 'POST', body: join({ username: `e${i}xx`, email: 'same@example.com' }) });
  const sixth = await browser().call(signup, { method: 'POST', body: join({ username: 'e9xx', email: 'same@example.com' }) });
  assert.equal(sixth.status, 429);
});

test('a public account without 2FA signs in with its password; with 2FA it needs the code', async () => {
  await member();
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: 'otter@example.com', password: PASSWORD } });
  assert.equal(r.json.step, 'done');
  assert.equal((await b.call(sessionRoute)).json.signedIn, true);
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: 'wrong password' } })).json.error, 'invalid_credentials');

  // Set up an authenticator from the account page.
  assert.equal((await b.call(security, { method: 'POST', body: { action: 'totp-start', password: 'wrong password' } })).json.error, 'password_wrong');
  const start = await b.call(security, { method: 'POST', body: { action: 'totp-start', password: PASSWORD } });
  assert.match(start.json.secret, /^[A-Z2-7]{32}$/);
  assert.equal((await b.call(security, { method: 'POST', body: { action: 'totp-finish', setup: start.json.setup, code: '000000' } })).json.error, 'code_wrong');
  const done = await b.call(security, { method: 'POST', body: { action: 'totp-finish', setup: start.json.setup, code: totpAt(start.json.secret) } });
  assert.equal(done.json.totp.local, true);
  assert.equal(done.json.codes.length, 10, 'first factor comes with backup codes');
  assert.match(db.table('gftvevents_totp_secrets')[0].secret_enc, /^v1:/);

  const again = browser();
  const r2 = await again.call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assert.equal(r2.json.step, 'verify');
  assert.equal(r2.headers['set-cookie'], undefined);
  const v = await again.call(verify, { method: 'POST', body: { challenge: r2.json.challenge, method: 'totp', code: totpAt(start.json.secret) } });
  assert.equal(v.status, 200);
  // A backup code from this site works too.
  const third = browser();
  const r3 = await third.call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assert.equal((await third.call(verify, { method: 'POST', body: { challenge: r3.json.challenge, method: 'backup', code: done.json.codes[0] } })).status, 200);

  // 2FA is optional for public accounts, so the last factor may go.
  const removed = await again.call(security, { method: 'POST', body: { action: 'totp-remove', password: PASSWORD } });
  assert.equal(removed.status, 200);
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } })).json.step, 'done');
});

test('a public account can never reach the editor routes', async () => {
  const b = await member();
  const r = await b.call(manage);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'manage_only');
  const e = addEvent({ slug: 'some-event' });
  assert.equal((await b.call(cover, { method: 'POST', body: { id: e.id, image: await webp() } })).status, 403);
});

// ---------------------------------------------------------------------------
// RSVP by public accounts, as editors see it
// ---------------------------------------------------------------------------

test('public and staff accounts RSVP to the same event; the editor sees names, never emails', async () => {
  const event = addEvent({ slug: 'mixed-meet', capacity: 2, is_online: true, online_url: 'https://meet.example.com/x' });
  const m = await member();
  const s = await staff('editor', { is_editor: true });
  const going = await m.call(rsvp, { method: 'POST', body: { slug: 'mixed-meet', going: true } });
  assert.equal(going.status, 200);
  assert.equal(going.json.event.where.onlineUrl, 'https://meet.example.com/x');
  await s.call(rsvp, { method: 'POST', body: { slug: 'mixed-meet', going: true } });
  // Full now, for a third person.
  const third = await member(browser(), { username: 'badger', email: 'badger@example.com' });
  assert.equal((await third.call(rsvp, { method: 'POST', body: { slug: 'mixed-meet', going: true } })).json.error, 'event_full');

  const view = await s.call(manage, { query: { id: event.id } });
  const names = view.json.attendees.map((a) => [a.username, a.staff]).sort();
  assert.deepEqual(names, [['editor', true], ['otter', false]]);
  assert.equal(JSON.stringify(view.json.attendees).includes('example.com'), false, 'no emails');
  assert.deepEqual(leaks(view.json), []);

  // An editor can take a public account off the list.
  const removed = await s.call(manage, { method: 'POST', body: { action: 'remove-attendee', id: event.id, username: 'otter', staff: false } });
  assert.deepEqual(removed.json.attendees.map((a) => a.username), ['editor']);
});

test('a public account can delete itself, and its RSVPs go with it', async () => {
  addEvent({ slug: 'bye-meet' });
  const m = await member();
  await m.call(rsvp, { method: 'POST', body: { slug: 'bye-meet', going: true } });
  // A sticker pack on the account (migrations/020): its files go too.
  const accountId = db.table('gftvevents_accounts')[0].id;
  const pack = { id: crypto.randomUUID(), account_id: accountId, name: 'ByePack', title: 'Bye' };
  await db.from('gftvevents_sticker_packs').insert(pack);
  const stickerPath = `${accountId}/StickerFileName1234567.webm`;
  const stillPath = `${accountId}/StillFileName12345678.webp`;
  await db.from('gftvevents_stickers').insert({ pack_id: pack.id, account_id: accountId, path: stickerPath, still_path: stillPath, format: 'webm', width: 512, height: 512 });
  await db.storage.from('gftvevents_stickers').upload(stickerPath, Buffer.from('webm'));
  await db.storage.from('gftvevents_stickers').upload(stillPath, Buffer.from('webp'));
  assert.equal((await m.call(security, { method: 'POST', body: { action: 'delete-account', password: 'nope nope nope' } })).json.error, 'password_wrong');
  const gone = await m.call(security, { method: 'POST', body: { action: 'delete-account', password: PASSWORD } });
  assert.equal(gone.status, 200);
  assert.equal(db.table('gftvevents_accounts').length, 0);
  assert.equal(db.table('gftvevents_stickers').length, 0);
  assert.equal([...db.objects.keys()].some((key) => key.startsWith('gftvevents_stickers/')), false, 'the sticker files are deleted');
  assert.equal(db.table('gftvevents_attendees').length, 0);
  assert.equal(db.table('gftvevents_sessions').length, 0);
  const s = await staff('keeper');
  assert.equal((await s.call(security, { method: 'POST', body: { action: 'delete-account', password: PASSWORD } })).json.error, 'staff_account');
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('a forgotten password is reset with a Telegram code, signing every other device out', async () => {
  const m = await member();
  await linkTelegram(m);
  const start = await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'otter' } });
  assert.equal(start.json.telegram, true);
  assert.equal(start.json.factor.required, false);
  const b = browser();
  sent = [];
  await b.call(recover, { method: 'POST', body: { action: 'send', challenge: start.json.challenge } });
  assert.match(sent[0].body.rich_message.markdown, /## Password reset code/);
  const code = sent[0].body.rich_message.markdown.match(/`(\d{6})`/)[1];
  assert.equal((await b.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: '000000', newPassword: 'a brand new secret' } })).json.error, 'code_wrong');
  const done = await b.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: code, newPassword: 'a brand new secret' } });
  assert.equal(done.status, 200);
  assert.equal((await m.call(sessionRoute)).json.signedIn, false, 'the old device is signed out');
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } })).json.error, 'invalid_credentials');
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: 'a brand new secret' } })).json.step, 'done');
});

test('reset needs the second factor too when there is one; staff and accounts without Telegram are told', async () => {
  const m = await member();
  await linkTelegram(m);
  const start = await m.call(security, { method: 'POST', body: { action: 'totp-start', password: PASSWORD } });
  await m.call(security, { method: 'POST', body: { action: 'totp-finish', setup: start.json.setup, code: totpAt(start.json.secret) } });
  const r = await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'otter' } });
  assert.equal(r.json.factor.required, true);
  sent = [];
  await browser().call(recover, { method: 'POST', body: { action: 'send', challenge: r.json.challenge } });
  const code = sent[0].body.rich_message.markdown.match(/`(\d{6})`/)[1];
  const without = await browser().call(recover, { method: 'POST', body: { action: 'finish', challenge: r.json.challenge, telegramCode: code, newPassword: 'another new secret' } });
  assert.equal(without.json.error, 'code_wrong');
  const withIt = await browser().call(recover, { method: 'POST', body: { action: 'finish', challenge: r.json.challenge, telegramCode: code, factor: 'totp', code: totpAt(start.json.secret), newPassword: 'another new secret' } });
  assert.equal(withIt.status, 200);

  await member(browser(), { username: 'nochat', email: 'nochat@example.com' });
  const none = (await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'nochat' } })).json;
  assert.equal(none.found, true);
  assert.equal(none.telegram, false);
  assert.equal(none.backup, false, 'no 2FA, so only a staff code can reset it');
  const nobody = (await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'nobody-here' } })).json;
  assert.deepEqual(nobody, { ok: true, found: false });
  await staff('stafffox');
  // A staff account gets exactly the answer an unknown name gets (help desk #18).
  assert.deepEqual((await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'stafffox' } })).json, nobody);
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test('push subscriptions are kept in Redis, checked, capped and removable', async () => {
  const m = await member();
  const status = await m.call(notifications);
  assert.equal(status.json.push.available, true);
  assert.equal(status.json.push.publicKey, process.env.VAPID_PUBLIC_KEY);

  const evil = await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://169.254.169.254/latest') } });
  assert.equal(evil.json.error, 'push_service_unknown');
  const ok = await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  assert.equal(ok.json.push.devices, 1);
  const accountId = db.table('gftvevents_accounts')[0].id;
  const stored = JSON.parse(Object.values(await redisFake.hgetall(`ghe:push:${accountId}`))[0]);
  assert.equal(stored.endpoint, 'https://fcm.googleapis.com/fcm/send/device-1');
  // The same device again does not count twice.
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  assert.equal((await m.call(notifications)).json.push.devices, 1);
  for (let i = 2; i <= 10; i += 1) await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription(`https://fcm.googleapis.com/fcm/send/device-${i}`) } });
  const eleventh = await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/device-11') } });
  assert.equal(eleventh.json.error, 'push_too_many');
  const off = await m.call(notifications, { method: 'POST', body: { action: 'unsubscribe', endpoint: 'https://fcm.googleapis.com/fcm/send/device-1' } });
  assert.equal(off.json.push.devices, 9);

  const test1 = await m.call(notifications, { method: 'POST', body: { action: 'test' } });
  // No count comes back (help desk #18); the nine devices still get it.
  assert.deepEqual(test1.json, { ok: true });
  assert.equal(pushes.length, 9);
});

test('each card tests its own way in: the device test is push only, the Telegram test the linked chat only', async () => {
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  // Not linked yet: the Telegram test says so.
  assert.equal((await m.call(notifications, { method: 'POST', body: { action: 'test', channel: 'telegram' } })).json.error, 'telegram_not_linked');
  await linkTelegram(m);
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true } });
  sent = [];
  pushes = [];
  // The device test: push only, even with notices also going to Telegram.
  const device = await m.call(notifications, { method: 'POST', body: { action: 'test', channel: 'device' } });
  assert.deepEqual(device.json, { ok: true });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, 'Test: GFTV HelloEvents');
  assert.equal(sent.length, 0);
  // The Telegram test: the linked chat only, even with notices there off.
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: false } });
  pushes = [];
  const telegram = await m.call(notifications, { method: 'POST', body: { action: 'test', channel: 'telegram' } });
  assert.deepEqual(telegram.json, { ok: true });
  assert.equal(pushes.length, 0);
  const message = sent.find((each) => each.url.endsWith('/sendRichMessage'));
  assert.equal(message.body.chat_id, 777);
  assert.equal((await m.call(notifications, { method: 'POST', body: { action: 'test', channel: 'sms' } })).json.error, 'bad_request');
});

test('changing when or where an event happens tells the people going, by push and Telegram, with public fields only', async () => {
  const event = addEvent({ slug: 'moving-meet', description: 'A meet that moves.', description_zh: '会搬家的聚会。', venue_name: 'Old Hall', is_online: true, online_url: 'https://meet.example.com/secret', venue_address: '1 Secret Road', address_attendees_only: true });
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await linkTelegram(m);
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true } });
  await m.call(rsvp, { method: 'POST', body: { slug: 'moving-meet', going: true } });
  const quiet = await member(browser(), { username: 'quiet', email: 'quiet@example.com' });
  await quiet.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/quiet') } });
  await quiet.call(notifications, { method: 'POST', body: { action: 'prefs', updates: false } });
  await quiet.call(rsvp, { method: 'POST', body: { slug: 'moving-meet', going: true } });
  // Their "You're going" notices, before any change.
  await settle();
  pushes = [];

  const ed = await staff('editor', { is_editor: true });
  const current = (await ed.call(manage, { query: { id: event.id } })).json.event;
  sent = [];
  // A title change alone tells nobody.
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, title: 'Moving Meet' } } });
  await settle();
  assert.equal(pushes.length, 0);
  const moved = [{ ...current.locations[0], venueName: 'New Hall' }];
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, title: 'Moving Meet', locations: moved } } });
  await settle();
  assert.equal(pushes.length, 1, 'only the person who wants updates');
  // It names what changed, and the push, which can show on a locked screen,
  // keeps to the public venue name.
  assert.equal(pushes[0].payload.title, 'Event location changed: Moving Meet');
  assert.equal(pushes[0].payload.body, 'Event location changed: New Hall');
  assert.equal(pushes[0].payload.url, 'https://events.globalfurry.tv/e/moving-meet');
  assert.equal(JSON.stringify(pushes).includes('meet.example.com'), false);
  assert.equal(JSON.stringify(pushes).includes('Secret Road'), false);
  // Telegram, in the chat of someone going: before and now, then every
  // place with its address, and the online link, like a reminder.
  const tgNotice = sent.find((s) => s.url.endsWith('/sendRichMessage'));
  assert.equal(tgNotice.body.chat_id, 777);
  const markdown = tgNotice.body.rich_message.markdown;
  for (const part of ['## Event location changed', '## What changed', '### Event location changed', '|  | Before | Now |', '| Venue | Old Hall | New Hall |',
    '## Event details', '| Online link | https://meet.example.com/secret |', '## Where', '### Event location', '| Address | 1 Secret Road |']) {
    assert.ok(markdown.includes(part), `${part} in\n${markdown}`);
  }
  assert.equal(markdown.includes('| Address | 1 Secret Road | 1 Secret Road |'), false, 'only what changed, side by side');

  pushes = [];
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, title: 'Moving Meet', locations: moved, status: 'cancelled' } } });

  await settle();
  assert.equal(pushes[0].payload.title, 'Event cancelled: Moving Meet');
});

test('joining sends a "You are going" notice with every place, whatever the notice choices', async () => {
  addEvent({
    slug: 'joined-meet', title: 'Joined Meet', description: 'A meet.', description_zh: '聚会。', venue_name: 'Hall', venue_address: '1 Secret Road', address_attendees_only: true,
    locations: [
      { label: 'event', venue_name: 'Hall', venue_address: '1 Secret Road', city: 'Singapore', country: 'SG' },
      { label: 'meeting', venue_name: 'Exit B', city: 'Singapore', country: 'SG' },
    ],
  });
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await linkTelegram(m);
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true, updates: false, reminderHours: [] } });
  sent = [];
  pushes = [];
  await m.call(rsvp, { method: 'POST', body: { slug: 'joined-meet', going: true } });
  await settle();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, "You're going: Joined Meet");
  assert.equal(JSON.stringify(pushes).includes('Secret Road'), false);
  const markdown = sent.find((s) => s.url.endsWith('/sendRichMessage')).body.rich_message.markdown;
  for (const part of ["## You're going", '### Event location', '| Address | 1 Secret Road |', '### Meeting location', '| Venue | Exit B |']) {
    assert.ok(markdown.includes(part), `${part} in\n${markdown}`);
  }
  // Changing what they are coming for is not joining again.
  pushes = [];
  await m.call(rsvp, { method: 'POST', body: { slug: 'joined-meet', going: true } });
  await settle();
  assert.equal(pushes.length, 0);
});

test('autosaving one change field by field tells the people going once, and a change put back tells nobody', async () => {
  const event = addEvent({ slug: 'autosaved-meet', description: 'A meet.', description_zh: '聚会。', venue_name: 'Old Hall' });
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await m.call(rsvp, { method: 'POST', body: { slug: 'autosaved-meet', going: true } });
  await settle();
  pushes = [];
  const ed = await staff('editor', { is_editor: true });
  const current = (await ed.call(manage, { query: { id: event.id } })).json.event;
  const save = (changes) => ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, ...changes } } });

  // Long enough that the three saves below always land inside one wait,
  // even when the whole suite runs at once and each save is slow (with 60 ms
  // the first save's wait could end before the third save, now and then).
  changeNotice.waitMs = 1500;
  // And a grace, as in production: with none, the last save's background
  // send can wake the millisecond its notice falls due, read it as not due
  // yet by a rounding, and send nothing.
  changeNotice.graceMs = 100;
  try {
    // A new place, then a new start time, then the title: three saves, one notice.
    const moved = [{ ...current.locations[0], venueName: 'New Hall' }];
    await save({ locations: moved });
    await save({ locations: moved, startTime: '15:00' });
    await save({ locations: moved, startTime: '15:00', title: 'Autosaved Meet' });
    assert.equal(pushes.length, 0, 'nothing before the wait is over');
    await settle();
    assert.equal(pushes.length, 1);
    // Two changes: each named in the push.
    assert.equal(pushes[0].payload.title, 'Event updated: Autosaved Meet');
    assert.match(pushes[0].payload.body, /^Date and time changed|^Now /);
    assert.match(pushes[0].payload.body, /Event location changed: New Hall/);
    const row = db.table('gftvevents_events').find((r) => r.id === event.id);
    assert.equal(row.notice_base, null);
    assert.equal(row.notice_due_at, null);

    // Moved and moved back before the wait is over: nobody hears.
    pushes = [];
    const now = (await ed.call(manage, { query: { id: event.id } })).json.event;
    await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...now, startTime: '18:00' } } });
    await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: now } });
    await settle();
    assert.equal(pushes.length, 0);
  } finally {
    changeNotice.waitMs = 0;
    changeNotice.graceMs = 0;
  }
});

test('the hourly cron sends a queued change notice that was left over', async () => {
  const event = addEvent({ slug: 'left-over-meet', description: 'A meet.', description_zh: '聚会。', venue_name: 'Old Hall' });
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await m.call(rsvp, { method: 'POST', body: { slug: 'left-over-meet', going: true } });
  await settle();
  pushes = [];
  const row = db.table('gftvevents_events').find((r) => r.id === event.id);
  // As a save leaves it when its background send was stopped.
  row.notice_base = { ...row, venue_name: 'Older Hall' };
  row.notice_due_at = new Date(Date.now() - 60_000).toISOString();
  const run = await browser().call(cronNotify, { headers: { authorization: 'Bearer cron-test' } });
  assert.equal(run.json.changed, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, 'Event location changed: ' + row.title);
  assert.equal(await flushDueChanges(), 0, 'sent once');
});

test('a gone push subscription is forgotten', async () => {
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/gone') } });
  await m.call(notifications, { method: 'POST', body: { action: 'test' } });
  assert.equal((await m.call(notifications)).json.push.devices, 0);
});

test('reminder times are any of 1, 2 or 3 hours, a day or a week before, and nothing else', async () => {
  const m = await member();
  assert.deepEqual((await m.call(notifications)).json.prefs.reminderHours, [24], 'a day before to start with');
  const picked = await m.call(notifications, { method: 'POST', body: { action: 'prefs', reminderHours: [1, 168, 24, 1] } });
  assert.deepEqual(picked.json.prefs.reminderHours, [168, 24, 1], 'each once, soonest last');
  const account = () => db.table('gftvevents_accounts').find((a) => a.username === 'otter');
  assert.deepEqual(account().reminder_hours, [168, 24, 1]);
  assert.equal(account().notify_reminders, true);
  for (const bad of [[5], [24, 'x'], '24', [1, 2, 3, 24, 168, 1]]) {
    const refused = await m.call(notifications, { method: 'POST', body: { action: 'prefs', reminderHours: bad } });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  const none = await m.call(notifications, { method: 'POST', body: { action: 'prefs', reminderHours: [] } });
  assert.deepEqual(none.json.prefs.reminderHours, []);
  assert.equal(account().notify_reminders, false);
  // A page from before reminder times sends reminders: true or false.
  assert.deepEqual((await m.call(notifications, { method: 'POST', body: { action: 'prefs', reminders: true } })).json.prefs.reminderHours, [24]);
});

test('the cron reminds people going at the times they picked, once each, with every place on Telegram', async () => {
  // A little over the minutes, so the heading rounds to them.
  const at = (minutes) => new Date(Date.now() + minutes * 60_000 + 20_000).toISOString();
  const soon = addEvent({
    slug: 'harbour-meet', title: 'Harbour Meet', starts_at: at(50), ends_at: at(290),
    description: 'A walk.', description_zh: '散步。',
    venue_name: 'Marina Barrage', venue_address: '8 Marina Gardens Drive', city: 'Singapore', country: 'SG', address_attendees_only: true,
    is_online: true, online_url: 'https://meet.example.com/harbour',
    locations: [
      { label: 'event', venue_name: 'Marina Barrage', venue_address: '8 Marina Gardens Drive', city: 'Singapore', country: 'SG', maps_url: 'https://maps.app.goo.gl/barrage' },
      { label: 'meeting', venue_name: 'Bayfront MRT, Exit B', city: 'Singapore', country: 'SG' },
    ],
    meal_options: [
      { id: 'lunch', label: null, limit: null, locations: [] },
      { id: 'dinner', label: null, limit: null, locations: [{ label: 'meal', venue_name: 'Lau Pa Sat', venue_address: '18 Raffles Quay', city: 'Singapore', country: 'SG', maps_url: null }] },
    ],
  });
  addEvent({ slug: 'later-meet', title: 'Later Meet', starts_at: at(5 * 24 * 60), venue_name: 'Hall' });
  addEvent({ slug: 'far-meet', title: 'Far Meet', starts_at: at(10 * 24 * 60) });

  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await linkTelegram(m);
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true, reminderHours: [1, 24, 168] } });
  for (const slug of ['harbour-meet', 'later-meet', 'far-meet']) {
    await m.call(rsvp, { method: 'POST', body: { slug, going: true } });
  }
  // Someone with no reminder times, and someone else who says they are going
  // only now, after the hour-before mark.
  const quiet = await member(browser(), { username: 'quiet', email: 'quiet@example.com' });
  await quiet.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/quiet') } });
  await quiet.call(notifications, { method: 'POST', body: { action: 'prefs', reminderHours: [] } });
  await quiet.call(rsvp, { method: 'POST', body: { slug: 'harbour-meet', going: true } });
  const late = await member(browser(), { username: 'late', email: 'late@example.com' });
  await late.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/late') } });
  await late.call(notifications, { method: 'POST', body: { action: 'prefs', reminderHours: [1] } });
  // The first two said they were going days ago.
  const otter = db.table('gftvevents_accounts').find((a) => a.username === 'otter');
  const quietId = db.table('gftvevents_accounts').find((a) => a.username === 'quiet').id;
  for (const row of db.table('gftvevents_attendees')) {
    if (row.user_id === otter.id || row.user_id === quietId) {
      row.created_at = new Date(Date.now() - 20 * 86400_000).toISOString();
    }
  }
  await late.call(rsvp, { method: 'POST', body: { slug: 'harbour-meet', going: true } });
  // Their "You're going" notices, before the cron.
  await settle();
  pushes = [];
  sent = [];

  assert.equal((await browser().call(cronNotify, { headers: {} })).status, 401);
  const run = () => browser().call(cronNotify, { headers: { authorization: 'Bearer cron-test' } });
  const first = await run();
  assert.equal(first.json.reminded, 2, 'the hour before Harbour Meet, and the week before Later Meet');
  assert.deepEqual(pushes.map((p) => p.payload.title).sort(), ['Starting in 5 days: Later Meet', 'Starting in 50 minutes: Harbour Meet']);
  assert.ok(pushes.every((p) => p.endpoint.endsWith('device-1')), 'nobody else');
  // The push, which can show on a locked screen, keeps to the public when
  // and where.
  const harbourPush = pushes.find((p) => p.payload.title.includes('Harbour'));
  assert.equal(JSON.stringify(harbourPush).includes('Marina Gardens'), false);
  assert.equal(JSON.stringify(harbourPush).includes('meet.example.com'), false);

  // Telegram, in the chat of someone going: every place, the meal held
  // somewhere else, and the online link.
  const message = sent.filter((s) => s.url.endsWith('/sendRichMessage')).map((s) => s.body).find((body) => body.rich_message.markdown.includes('Harbour Meet'));
  assert.equal(message.chat_id, 777);
  const markdown = message.rich_message.markdown;
  assert.match(markdown, /^## Starting in 50 minutes\n\n\*\*Harbour Meet\*\*/);
  for (const part of ['| When |', '| Ends |', '| Coming for | The whole event |', '| Online link | https://meet.example.com/harbour |',
    '## Where', '### Event location', '| Address | 8 Marina Gardens Drive |', '| Country | Singapore |', '| Map | https://maps.app.goo.gl/barrage |',
    '### Meeting location', '| Venue | Bayfront MRT, Exit B |', '## Meals held elsewhere', '### Dinner', '| Venue | Lau Pa Sat |', '| Address | 18 Raffles Quay |',
    'https://events.globalfurry.tv/e/harbour-meet']) {
    assert.ok(markdown.includes(part), `${part} in\n${markdown}`);
  }
  assert.equal(markdown.includes('### Lunch'), false, 'lunch is at the event');
  assert.equal(markdown.includes('## Event updated'), false);

  // Marked: the week and day before Harbour Meet with its hour, as they were
  // overtaken; the late one marked without a reminder.
  const sentFor = (slug, userId) => db.table('gftvevents_attendees').find((a) => a.event_id === db.table('gftvevents_events').find((e) => e.slug === slug).id && a.user_id === userId).reminders_sent;
  assert.deepEqual(sentFor('harbour-meet', otter.id), [168, 24, 1]);
  assert.deepEqual(sentFor('later-meet', otter.id), [168]);
  assert.deepEqual(sentFor('far-meet', otter.id), []);
  assert.deepEqual(sentFor('harbour-meet', db.table('gftvevents_accounts').find((a) => a.username === 'late').id), [1]);
  assert.deepEqual(sentFor('harbour-meet', quietId), []);

  pushes = [];
  assert.equal((await run()).json.reminded, 0, 'not twice');
  assert.equal(soon.slug, 'harbour-meet');

  // A new event: announced once. A draft and a future release are not.
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', newEvents: true } });
  addEvent({ slug: 'brand-new', title: 'Brand New Meet', announced_at: null });
  addEvent({ slug: 'secret-draft', status: 'draft', announced_at: null });
  addEvent({ slug: 'not-yet', publish_at: new Date(Date.now() + 86400_000).toISOString(), announced_at: null });
  const second = await run();
  assert.equal(second.json.announced, 1);
  assert.deepEqual(pushes.map((p) => p.payload.title), ['New event: Brand New Meet']);
  pushes = [];
  assert.equal((await run()).json.announced, 0);
});

test('the bot, its codes and every notice speak the language the account uses the site in', async () => {
  const at = (minutes) => new Date(Date.now() + minutes * 60_000 + 20_000).toISOString();
  addEvent({ slug: 'lantern-meet', title: 'Lantern Meet', starts_at: at(50), venue_name: 'Gardens', city: 'Singapore' });
  const hook = (chatId, text, from = {}) => browser().call(webhook, {
    method: 'POST', headers: HOOK, body: { message: { chat: { id: chatId, type: 'private' }, from, text } },
  });
  const plainTo = (chatId) => sent.filter((s) => s.url.endsWith('/sendMessage') && s.body.chat_id === chatId).map((s) => s.body.text);
  const richTo = (chatId) => sent.filter((s) => s.url.endsWith('/sendRichMessage') && s.body.chat_id === chatId).map((s) => s.body.rich_message.markdown);

  // The site saves the language in use; only the site's codes are taken.
  const m = await member();
  assert.equal((await m.call(sessionRoute)).json.user.locale, null, 'none saved yet');
  assert.equal((await m.call(profile, { method: 'POST', body: { locale: 'fr' } })).json.error, 'bad_request');
  const saved = await m.call(profile, { method: 'POST', body: { locale: 'zh-sg' } });
  assert.equal(saved.json.user.locale, 'zh-SG');
  assert.equal((await m.call(sessionRoute)).json.user.locale, 'zh-SG');

  // Linking answers in the account's language, and so does everything after.
  await linkTelegram(m, 801);
  assert.match(plainTo(801).at(-1), /^已绑定至 events\.globalfurry\.tv 上的账户 otter。/);
  await hook(801, 'hello', { language_code: 'en' });
  assert.match(richTo(801).at(-1), /^# GFTV HelloEvents\n\n此机器人为/, 'the account wins over the Telegram app');
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true, reminderHours: [1] } });
  sent = [];
  pushes = [];
  await m.call(notifications, { method: 'POST', body: { action: 'test', channel: 'telegram' } });
  assert.match(richTo(801).at(-1), /^## 测试\n\n\*\*GFTV HelloEvents\*\*\n\n此聊天可以正常接收通知。/);
  await m.call(notifications, { method: 'POST', body: { action: 'test', channel: 'device' } });
  assert.deepEqual(pushes.map((p) => [p.payload.title, p.payload.body]), [['测试: GFTV HelloEvents', '此设备可以正常接收通知。']]);

  // Someone else, in Malay, going to the same event.
  const kancil = await member(browser(), { username: 'kancil', email: 'kancil@example.com' });
  await kancil.call(profile, { method: 'POST', body: { locale: 'ms' } });
  await kancil.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/kancil') } });
  await linkTelegram(kancil, 802);
  assert.match(plainTo(802).at(-1), /^Dipautkan ke akaun kancil/);
  await kancil.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true, reminderHours: [1] } });

  // Joining, then the reminder: each in their own language.
  sent = [];
  for (const b of [m, kancil]) {
    await b.call(rsvp, { method: 'POST', body: { slug: 'lantern-meet', going: true } });
  }
  await settle();
  assert.match(richTo(801)[0], /^## 你已报名\n\n\*\*Lantern Meet\*\*/);
  assert.match(richTo(802)[0], /^## Anda akan hadir\n\n\*\*Lantern Meet\*\*/);
  for (const row of db.table('gftvevents_attendees')) {
    row.created_at = new Date(Date.now() - 20 * 86400_000).toISOString();
  }
  sent = [];
  pushes = [];
  const run = await browser().call(cronNotify, { headers: { authorization: 'Bearer cron-test' } });
  assert.equal(run.json.reminded, 2);
  assert.match(richTo(801)[0], /^## 50 分钟后开始\n\n\*\*Lantern Meet\*\*/);
  assert.ok(richTo(801)[0].includes('| 时间 |'));
  assert.match(richTo(802)[0], /^## Bermula dalam 50 minit\n\n\*\*Lantern Meet\*\*/);
  assert.deepEqual(pushes.map((p) => p.payload.title).sort(), ['50 分钟后开始: Lantern Meet', 'Bermula dalam 50 minit: Lantern Meet']);

  // Changing the language on the site changes the bot's at once.
  await m.call(profile, { method: 'POST', body: { locale: 'ta' } });
  sent = [];
  await hook(801, '/unlink');
  assert.deepEqual(plainTo(801), ['இணைப்பு துண்டிக்கப்பட்டது. இந்த அரட்டைக்கு இனி குறியீடுகள் வராது.']);

  // A chat linked to no account: its Telegram app's language, if the site
  // has it, else English.
  sent = [];
  await hook(803, 'hi', { language_code: 'zh-hans' });
  await hook(804, 'hi', { language_code: 'de' });
  await hook(805, '/unlink', { language_code: 'ms' });
  assert.match(richTo(803)[0], /此机器人为/);
  assert.match(richTo(804)[0], /This bot sends sign-in codes/);
  assert.deepEqual(plainTo(805), ['Sembang ini tidak dipautkan ke mana-mana akaun.']);
});

test('deployed before migrations/029, everything works in English and the language waits for the column', async (t) => {
  db = createFakeDb({ withoutLocale: true });
  useTestClient(db);
  resetLocaleColumn();
  t.after(resetLocaleColumn);
  const warnings = [];
  t.mock.method(console, 'warn', (...parts) => warnings.push(parts.join(' ')));
  addEvent({ slug: 'early-meet', title: 'Early Meet', venue_name: 'Hall' });

  // Sign-up, the session and signing in again all work.
  const m = await member();
  assert.equal((await m.call(sessionRoute)).json.user.locale, null);
  assert.equal((await browser().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } })).status, 200);
  // The page's language save is taken and left for later; anything sent
  // with it is still saved.
  const saved = await m.call(profile, { method: 'POST', body: { locale: 'zh-SG' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.user.locale, null);
  const renamed = await m.call(profile, { method: 'POST', body: { displayName: 'River Otter', locale: 'ms' } });
  assert.equal(renamed.json.user.displayName, 'River Otter');

  // The bot and the notices go out, in English.
  await linkTelegram(m, 901);
  const linked = sent.filter((s) => s.url.endsWith('/sendMessage') && s.body.chat_id === 901).at(-1);
  assert.match(linked.body.text, /^Linked to the account otter/);
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true } });
  sent = [];
  await m.call(rsvp, { method: 'POST', body: { slug: 'early-meet', going: true } });
  await settle();
  const going = sent.find((s) => s.url.endsWith('/sendRichMessage') && s.body.chat_id === 901);
  assert.match(going.body.rich_message.markdown, /^## You're going\n\n\*\*Early Meet\*\*/);
  assert.equal(warnings.filter((line) => line.includes('migrations/029_account_locale.sql')).length, 1, 'said once');
});

// ---------------------------------------------------------------------------
// Cover pictures
// ---------------------------------------------------------------------------

test('editors upload a WebP cover to the bucket; it is checked, replaced cleanly and deleted with the event', async () => {
  const ed = await staff('admin', { is_admin: true });
  const event = addEvent({ slug: 'cover-meet' });
  const first = await ed.call(cover, { method: 'POST', body: { id: event.id, image: await webp() } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  // This site's own address, never the bucket's (api/events/cover.js).
  assert.match(first.json.event.coverImageUrl, /^\/api\/events\/cover\?slug=[a-z0-9-]+&v=[A-Za-z0-9_-]+$/);
  assert.equal(db.objects.size, 1);
  const [key, object] = [...db.objects][0];
  assert.equal(object.contentType, 'image/webp');
  assert.ok(key.startsWith(`gftvevents_covers/${event.id}/`));

  const pub = await browser().call(detail, { query: { slug: 'cover-meet' } });
  assert.equal(pub.json.event.coverImageUrl, first.json.event.coverImageUrl);

  const png = `data:image/png;base64,${(await sharp({ create: { width: 800, height: 450, channels: 3, background: '#000' } }).png().toBuffer()).toString('base64')}`;
  assert.equal((await ed.call(cover, { method: 'POST', body: { id: event.id, image: png } })).json.error, 'cover_not_webp');
  assert.equal((await ed.call(cover, { method: 'POST', body: { id: event.id, image: await webp(200, 100) } })).json.error, 'cover_too_small');
  assert.equal(db.objects.size, 1, 'refused uploads store nothing');

  await ed.call(cover, { method: 'POST', body: { id: event.id, image: await webp(1200, 675) } });
  assert.equal(db.objects.size, 1, 'the old picture is deleted on replace');
  assert.notEqual([...db.objects.keys()][0], key);

  await ed.call(manage, { method: 'POST', body: { action: 'delete', id: event.id } });
  assert.equal(db.objects.size, 0, 'and with the event');
});
