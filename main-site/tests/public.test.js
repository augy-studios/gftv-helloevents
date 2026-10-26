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
const { useTestRedis } = await import('../api/_lib/redis.js');
const { useTestPushSender } = await import('../api/_lib/push.js');
const { settle } = await import('../api/_lib/notify.js');
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

const join = (over = {}) => ({ username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, agree: true, ...over });

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
  assert.deepEqual(r.json.user, { username: 'otter', displayName: 'Otter', avatarUrl: null, kind: 'public', role: 'member', canManage: false });
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

test('sign-up is rate limited per connection', async () => {
  for (let i = 0; i < 5; i += 1) await browser().call(signup, { method: 'POST', body: join({ username: `u${i}xx`, email: `${i}@example.com` }) });
  const sixth = await browser().call(signup, { method: 'POST', body: join({ username: 'u9xx', email: '9@example.com' }) });
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
  assert.equal((await m.call(security, { method: 'POST', body: { action: 'delete-account', password: 'nope nope nope' } })).json.error, 'password_wrong');
  const gone = await m.call(security, { method: 'POST', body: { action: 'delete-account', password: PASSWORD } });
  assert.equal(gone.status, 200);
  assert.equal(db.table('gftvevents_accounts').length, 0);
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
  assert.deepEqual((await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'nochat' } })).json, { ok: true, telegram: false });
  await staff('stafffox');
  assert.equal((await browser().call(recover, { method: 'POST', body: { action: 'start', identifier: 'stafffox' } })).json.staff, true);
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
  assert.equal(test1.json.reached, 1);
  assert.equal(pushes.length, 9);
});

test('changing when or where an event happens tells the people going, by push and Telegram, with public fields only', async () => {
  const event = addEvent({ slug: 'moving-meet', venue_name: 'Old Hall', is_online: true, online_url: 'https://meet.example.com/secret', venue_address: '1 Secret Road', address_attendees_only: true });
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await linkTelegram(m);
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', telegram: true } });
  await m.call(rsvp, { method: 'POST', body: { slug: 'moving-meet', going: true } });
  const quiet = await member(browser(), { username: 'quiet', email: 'quiet@example.com' });
  await quiet.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/quiet') } });
  await quiet.call(notifications, { method: 'POST', body: { action: 'prefs', updates: false } });
  await quiet.call(rsvp, { method: 'POST', body: { slug: 'moving-meet', going: true } });

  const ed = await staff('editor', { is_editor: true });
  const current = (await ed.call(manage, { query: { id: event.id } })).json.event;
  sent = [];
  // A title change alone tells nobody.
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, title: 'Moving Meet' } } });
  await settle();
  assert.equal(pushes.length, 0);
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, title: 'Moving Meet', venueName: 'New Hall' } } });
  await settle();
  assert.equal(pushes.length, 1, 'only the person who wants updates');
  assert.equal(pushes[0].payload.title, 'Event updated: Moving Meet');
  assert.equal(pushes[0].payload.url, 'https://events.globalfurry.tv/e/moving-meet');
  const all = JSON.stringify(pushes) + JSON.stringify(sent);
  assert.equal(all.includes('meet.example.com'), false);
  assert.equal(all.includes('Secret Road'), false);
  const tgNotice = sent.find((s) => s.url.endsWith('/sendRichMessage'));
  assert.equal(tgNotice.body.chat_id, 777);
  assert.match(tgNotice.body.rich_message.markdown, /## Event updated/);

  pushes = [];
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, title: 'Moving Meet', venueName: 'New Hall', status: 'cancelled' } } });
  await settle();
  assert.equal(pushes[0].payload.title, 'Event cancelled: Moving Meet');
});

test('a gone push subscription is forgotten', async () => {
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription('https://fcm.googleapis.com/fcm/send/gone') } });
  await m.call(notifications, { method: 'POST', body: { action: 'test' } });
  assert.equal((await m.call(notifications)).json.push.devices, 0);
});

test('the hourly cron sends each reminder once, and announces new events once to those who asked', async () => {
  const soon = addEvent({ slug: 'tomorrow-meet', starts_at: new Date(Math.floor((Date.now() + 20 * 3600_000) / 60_000) * 60_000).toISOString() });
  addEvent({ slug: 'later-meet', starts_at: new Date(Date.now() + 5 * 86400_000).toISOString() });
  const m = await member();
  await m.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription: subscription() } });
  await m.call(rsvp, { method: 'POST', body: { slug: 'tomorrow-meet', going: true } });
  await m.call(rsvp, { method: 'POST', body: { slug: 'later-meet', going: true } });
  await m.call(notifications, { method: 'POST', body: { action: 'prefs', newEvents: true } });

  assert.equal((await browser().call(cronNotify, { headers: {} })).status, 401);
  const run = () => browser().call(cronNotify, { headers: { authorization: 'Bearer cron-test' } });
  const first = await run();
  assert.equal(first.json.reminded, 1);
  assert.equal(pushes[0].payload.title, 'Tomorrow: Furmeet');
  assert.ok(db.table('gftvevents_attendees').find((a) => a.event_id === soon.id).reminded_at);
  pushes = [];
  assert.equal((await run()).json.reminded, 0, 'not twice');

  // A new event: announced once. A draft and a future release are not.
  addEvent({ slug: 'brand-new', title: 'Brand New Meet', announced_at: null });
  addEvent({ slug: 'secret-draft', status: 'draft', announced_at: null });
  addEvent({ slug: 'not-yet', publish_at: new Date(Date.now() + 86400_000).toISOString(), announced_at: null });
  const second = await run();
  assert.equal(second.json.announced, 1);
  assert.deepEqual(pushes.map((p) => p.payload.title), ['New event: Brand New Meet']);
  pushes = [];
  assert.equal((await run()).json.announced, 0);
});

// ---------------------------------------------------------------------------
// Cover pictures
// ---------------------------------------------------------------------------

test('editors upload a WebP cover to the bucket; it is checked, replaced cleanly and deleted with the event', async () => {
  const ed = await staff('admin', { is_admin: true });
  const event = addEvent({ slug: 'cover-meet' });
  const first = await ed.call(cover, { method: 'POST', body: { id: event.id, image: await webp() } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.match(first.json.event.coverImageUrl, /^https:\/\/project\.supabase\.co\/storage\/v1\/object\/public\/gftvevents_covers\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+\.webp$/);
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
