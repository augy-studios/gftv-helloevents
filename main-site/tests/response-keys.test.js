// Every answer a page asks for, with its exact keys pinned (help desk #18,
// Augy's rule F2): a response carries only what the page shows, plus the ids
// its buttons and actions send back. Nothing else, even about the person
// themselves. A new field has to be added here on purpose; a field no page
// reads should not be.
//
// Each answer is turned into its sorted key paths ("event.where.city",
// "events[].slug") and compared with the lists below, so a key that appears
// or disappears anywhere in an answer fails the test. Passkey options come
// from SimpleWebAuthn and the WebAuthn spec, so only their top key is pinned.
// Runs end to end against the in-memory database, a fake Redis, and
// recorders in place of Telegram and the push services.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_BOT_USERNAME = 'HelloEventsTestBot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.VAPID_PUBLIC_KEY = 'B'.repeat(87);
process.env.VAPID_PRIVATE_KEY = 'test-private-key';
process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { useTestPushSender } = await import('../api/_lib/push.js');
const { forgetNameFilters } = await import('../api/_lib/name-filter.js');
const { totpAt } = await import('../api/_lib/totp.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const recover = await route('auth/recover');
const sessionRoute = await route('auth/session');
const feed = await route('events/feed');
const detail = await route('events/detail');
const rsvp = await route('events/rsvp');
const manage = await route('manage/events');
const cover = await route('manage/cover');
const admin = await route('manage/admin');
const security = await route('me/security');
const notifications = await route('me/notifications');
const profile = await route('me/profile');
const rsvps = await route('me/rsvps');
const config = await route('public/config');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;
let sent;

// Telegram's Bot API, recorded rather than called.
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
  useTestPushSender(async () => {});
  forgetNameFilters();
  sent = [];
});

// ---------------------------------------------------------------------------
// Key paths
// ---------------------------------------------------------------------------

// Every key path in a value, sorted. An object adds "key" (and "parent.key"
// below it); a list adds its items' paths under "name[]". A path listed in
// opaque is kept, but not looked inside.
function keyPaths(value, opaque = [], prefix = '') {
  const paths = new Set();
  if (prefix && opaque.includes(prefix)) {
    return [];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const path of keyPaths(item, opaque, `${prefix}[]`)) {
        paths.add(path);
      }
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      let path = key;
      if (prefix) {
        path = `${prefix}.${key}`;
      }
      paths.add(path);
      for (const inner of keyPaths(value[key], opaque, path)) {
        paths.add(inner);
      }
    }
  }
  return [...paths].sort();
}

// An object's paths under a name, as keyPaths writes them.
const nest = (name, paths) => [name, ...paths.map((path) => `${name}.${path}`)];
// A list of objects' paths under a name.
const listOf = (name, paths) => [name, ...paths.map((path) => `${name}[].${path}`)];

// The answer was a success, and its keys are exactly "ok" plus expected.
function assertKeys(response, expected, opaque = []) {
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(keyPaths(response.json, opaque), [...new Set(['ok', ...expected])].sort());
}

// ---------------------------------------------------------------------------
// What each page shows
// ---------------------------------------------------------------------------

// The signed-in person: the account page shows all of it; the header and
// /manage read canManage and role.
const USER = ['username', 'displayName', 'avatarUrl', 'kind', 'role', 'canManage'];
const METHODS = ['totp', 'passkey', 'telegram', 'backup'];
const FACTOR = ['totp', 'passkey', 'backup', 'required'];

const WHEN = ['tba', 'startsAt', 'endsAt', 'timezone'];
const WHERE = ['online', 'venueName', 'city', 'country'];
// A card (the feed, and "Events you are going to"), for an event with dates
// and a price.
const CARD = [
  'slug', 'title', 'kind', 'summary', 'coverImageUrl', 'cancelled',
  ...nest('when', WHEN), ...nest('where', WHERE), ...nest('price', ['type', 'min', 'max', 'currency']),
  'going', 'rsvp',
];
// A card for a free event whose dates are still to be announced.
const CARD_TBA_FREE = [
  'slug', 'title', 'kind', 'summary', 'coverImageUrl', 'cancelled',
  ...nest('when', ['tba', 'timezone']), ...nest('where', WHERE), ...nest('price', ['type']),
  'going', 'rsvp',
];
// The event page: the card, plus what only the page shows.
const DETAIL = [
  ...CARD, 'price.note', 'capacity', 'left', 'description', 'organiserName', 'externalUrl',
  'where.address', 'where.addressForAttendees', 'where.onlineUrl', 'where.onlineUrlForAttendees',
  ...nest('viewer', ['signedIn', 'going', 'canManage']),
];

// /manage: a row of the event list, the edit form, an attendee.
const SUMMARY = ['id', 'slug', 'title', 'kind', 'status', 'released', 'startsAt', 'datesHidden', 'going', 'capacity'];
const EDITOR = [
  'id', 'slug', 'title', 'kind', 'status', 'datesHidden', 'timezone', 'capacity', 'summary', 'description',
  'startsLocal', 'endsLocal', 'publishLocal', 'isOnline', 'onlineUrl', 'venueName', 'venueAddress',
  'addressAttendeesOnly', 'city', 'country', 'coverImageUrl', 'hasCover', 'externalUrl', 'organiserName',
  'priceType', 'priceHidden', 'priceMin', 'priceMax', 'currency', 'priceNote', 'rsvpOpen', 'staffNotes',
];
const COVER = ['coverImageUrl', 'hasCover'];
const ATTENDEE = ['username', 'displayName', 'staff', 'rsvpAt'];
// The staff tools under the events on /manage.
const ALLOWANCE = ['id', 'perHour', 'label', 'expiresAt', 'by', 'here'];
const FILTER = ['id', 'term'];
const FLAGGED = ['username', 'displayName', 'term'];

// The account page: Security (passkeys added below when there are some) and
// Notifications.
const SECURITY = [
  'required', ...nest('totp', ['shared', 'local']), 'passkeys',
  ...nest('telegram', ['available', 'linked', 'username']), 'backupCodesLeft',
];
const PASSKEY = ['id', 'label', 'createdAt', 'lastUsedAt'];
const NOTIFY = [
  ...nest('prefs', ['updates', 'reminders', 'newEvents', 'telegram']),
  ...nest('push', ['available', 'publicKey', 'devices']),
  ...nest('telegram', ['available', 'linked']),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A browser on its own connection, so the per-connection rate limits stay
// out of the way.
let nextConnection = 0;
function on() {
  nextConnection += 1;
  const ip = `10.18.${Math.floor(nextConnection / 250)}.${(nextConnection % 250) + 1}`;
  const b = browser();
  const call = b.call;
  b.call = (handler, options = {}) => call(handler, { ip, ...options });
  return b;
}

const join = (over = {}) => ({ username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, agree: true, ...over });

// A signed-in public account: { b, joined (the sign-up answer), id }.
async function member(over = {}) {
  const b = on();
  const joined = await b.call(signup, { method: 'POST', body: join(over) });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  let username = 'otter';
  if (over.username) {
    username = over.username;
  }
  const id = db.table('gftvevents_accounts').find((account) => account.username === username).id;
  return { b, joined, id };
}

// A staff account on gftvhello_users with an authenticator, not signed in.
async function addStaff(username, over = {}) {
  const { data } = await db
    .from('gftvhello_users')
    .insert({
      username,
      display_name: username,
      email: `${username}@gftv.example`,
      password_hash: await bcrypt.hash(PASSWORD, 4),
      is_approved: true,
      totp_secret: SHARED_SECRET,
      ...over,
    })
    .select('id')
    .single();
  return data.id;
}

// A signed-in staff account: { b, id }.
async function staff(username, over = {}) {
  const id = await addStaff(username, over);
  const b = on();
  const first = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  const second = await b.call(verify, { method: 'POST', body: { challenge: first.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  return { b, id };
}

// A released event with dates, a paid price and a price note.
function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: over.slug,
    title: 'Furmeet',
    status: 'published',
    starts_at: new Date(Math.floor((Date.now() + 7 * 86400_000) / 60_000) * 60_000).toISOString(),
    ends_at: null,
    price_type: 'paid',
    price_min: 10,
    price_max: 20,
    currency: 'SGD',
    price_note: 'Cash at the door',
    capacity: 20,
    venue_name: 'Hall',
    city: 'Singapore',
    country: 'Singapore',
    announced_at: new Date().toISOString(),
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

function linkTelegram(userId, chatId = 777) {
  db.table('gftvevents_telegram_links').push({ user_id: userId, chat_id: chatId, telegram_username: 'otterchat', linked_at: new Date().toISOString() });
}

function addPasskey(userId, over = {}) {
  db.table('gftvevents_passkeys').push({
    id: crypto.randomUUID(),
    user_id: userId,
    credential_id: `cred-${db.table('gftvevents_passkeys').length + 1}`,
    public_key: 'AAAA',
    counter: 0,
    transports: ['internal'],
    label: 'Laptop',
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...over,
  });
}

// The six-digit code in the last Telegram message.
function telegramCode() {
  const message = sent.filter((entry) => entry.url.endsWith('/sendRichMessage')).at(-1);
  return message.body.rich_message.markdown.match(/`(\d{6})`/)[1];
}

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) } };
const webp = async () => `data:image/webp;base64,${(await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#ff8a4c' } }).webp().toBuffer()).toString('base64')}`;

// ---------------------------------------------------------------------------
// Signing up and signing in
// ---------------------------------------------------------------------------

test('sign-up, sign-in and the second step answer only what the sign-in pages read', async () => {
  // Sign-up and a password-only sign-in move on to the next page, which
  // asks /api/auth/session who is signed in.
  const { joined } = await member();
  assertKeys(joined, []);
  const done = await on().call(login, { method: 'POST', body: { identifier: 'otter', password: PASSWORD } });
  assertKeys(done, ['step']);

  const staffId = await addStaff('fox');
  linkTelegram(staffId, 4242);
  addPasskey(staffId);
  const b = on();
  const first = await b.call(login, { method: 'POST', body: { identifier: 'fox', password: PASSWORD } });
  assertKeys(first, ['challenge', 'step', ...nest('methods', METHODS)]);
  const challenge = first.json.challenge;
  assertKeys(await b.call(verify, { method: 'POST', body: { challenge, method: 'telegram-send' } }), ['sent']);
  assertKeys(await b.call(verify, { method: 'POST', body: { challenge, method: 'passkey-options' } }), ['options'], ['options']);
  assertKeys(await b.call(verify, { method: 'POST', body: { challenge, method: 'totp', code: totpAt(SHARED_SECRET) } }), []);
});

test('the session answers say who is signed in, and nothing more', async () => {
  assertKeys(await on().call(sessionRoute), ['signedIn']);
  const { b } = await member();
  assertKeys(await b.call(sessionRoute), ['signedIn', ...nest('user', USER)]);
  assertKeys(await b.call(sessionRoute, { method: 'POST', body: { action: 'logout-others' } }), ['signedIn']);
  assertKeys(await b.call(sessionRoute, { method: 'POST', body: { action: 'logout' } }), ['signedIn']);
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('starting a reset answers a staff account exactly like an unknown one', async () => {
  const start = (identifier) => on().call(recover, { method: 'POST', body: { action: 'start', identifier } });
  const unknown = await start('nobody-here');
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, { ok: true, found: false });

  await addStaff('stafffox');
  for (const identifier of ['stafffox', 'stafffox@gftv.example']) {
    const staffOnly = await start(identifier);
    assert.equal(staffOnly.status, unknown.status, identifier);
    assert.deepEqual(staffOnly.json, unknown.json, identifier);
    assert.equal(staffOnly.headers['set-cookie'], undefined, identifier);
  }

  // A suspended public account too: no second factors listed for it.
  await member({ username: 'sleepy', email: 'sleepy@example.com' });
  db.table('gftvevents_accounts').find((account) => account.username === 'sleepy').status = 'suspended';
  assert.deepEqual((await start('sleepy')).json, unknown.json);
});

test('a reset for a public account lists its ways back in, and each step answers only what the reset page reads', async () => {
  const { id } = await member();
  linkTelegram(id);
  const start = await on().call(recover, { method: 'POST', body: { action: 'start', identifier: 'otter' } });
  assertKeys(start, ['found', 'challenge', 'telegram', 'backup', ...nest('factor', FACTOR)]);
  const b = on();
  assertKeys(await b.call(recover, { method: 'POST', body: { action: 'send', challenge: start.json.challenge } }), ['sent']);
  const done = await b.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: telegramCode(), newPassword: 'a brand new secret' } });
  assertKeys(done, ['signedIn']);
  assert.equal(done.json.signedIn, true);

  // With a passkey, the reset page asks for its options after the Telegram code.
  const { id: badgerId } = await member({ username: 'badger', email: 'badger@example.com' });
  linkTelegram(badgerId, 778);
  addPasskey(badgerId);
  const again = await on().call(recover, { method: 'POST', body: { action: 'start', identifier: 'badger' } });
  assertKeys(again, ['found', 'challenge', 'telegram', 'backup', ...nest('factor', FACTOR)]);
  assert.equal(again.json.factor.required, true);
  const c = on();
  await c.call(recover, { method: 'POST', body: { action: 'send', challenge: again.json.challenge } });
  const options = await c.call(recover, { method: 'POST', body: { action: 'passkey-options', challenge: again.json.challenge, telegramCode: telegramCode() } });
  assertKeys(options, ['options'], ['options']);
});

// ---------------------------------------------------------------------------
// Events, as the public and attendees see them
// ---------------------------------------------------------------------------

test('event cards, the event page and an RSVP carry only what those pages show', async () => {
  addEvent({ slug: 'paid-meet' });
  addEvent({ slug: 'tba-meet', dates_hidden: true, starts_at: null, price_type: 'free', price_min: null, price_max: null, currency: null });

  assertKeys(await on().call(feed, { query: { when: 'upcoming' } }), ['nextOffset', ...listOf('events', CARD)]);
  assertKeys(await on().call(feed, { query: { when: 'tba' } }), ['nextOffset', ...listOf('events', CARD_TBA_FREE)]);
  assertKeys(await on().call(detail, { query: { slug: 'paid-meet' } }), ['preview', ...nest('event', DETAIL)]);

  const { b } = await member();
  assertKeys(await b.call(rsvp, { method: 'POST', body: { slug: 'paid-meet', going: true } }), nest('event', DETAIL));
  assertKeys(await b.call(detail, { query: { slug: 'paid-meet' } }), ['preview', ...nest('event', DETAIL)]);
  assertKeys(await b.call(rsvps), ['past', ...listOf('upcoming', nest('event', CARD))]);
  assertKeys(await b.call(rsvp, { method: 'POST', body: { slug: 'paid-meet', going: false } }), nest('event', DETAIL));
});

// ---------------------------------------------------------------------------
// /manage
// ---------------------------------------------------------------------------

test('the event list, the edit form, attendees and the cover answer only what /manage shows', async () => {
  const { b: editor } = await staff('editor', { is_editor: true });
  const made = await editor.call(manage, {
    method: 'POST',
    body: { action: 'create', event: { title: 'Mega Con', kind: 'convention', status: 'published', timezone: 'Asia/Singapore', startsLocal: '2030-01-01T10:00', priceType: 'free', capacity: '50' } },
  });
  assertKeys(made, nest('event', EDITOR));
  const id = made.json.event.id;
  assertKeys(await editor.call(manage, { method: 'POST', body: { action: 'update', id, event: { ...made.json.event, title: 'Mega Con Two' } } }), nest('event', EDITOR));

  const { b: otter } = await member();
  await otter.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true } });
  await editor.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true } });
  assertKeys(await editor.call(manage), listOf('events', SUMMARY));
  assertKeys(await editor.call(manage, { query: { id } }), [...nest('event', EDITOR), ...listOf('attendees', ATTENDEE)]);

  assertKeys(await editor.call(cover, { method: 'POST', body: { id, image: await webp() } }), nest('event', COVER));
  assertKeys(await editor.call(cover, { method: 'POST', body: { id, remove: true } }), nest('event', COVER));

  const removed = await editor.call(manage, { method: 'POST', body: { action: 'remove-attendee', id, username: 'otter', staff: false } });
  assertKeys(removed, listOf('attendees', ATTENDEE));

  const { b: boss } = await staff('boss', { is_admin: true });
  assertKeys(await boss.call(manage, { method: 'POST', body: { action: 'delete', id } }), ['deleted']);
});

test('the staff tools answer only what their sections on /manage show', async () => {
  await member({ username: 'pride_otter', displayName: 'Pride Guard Otter', email: 'p@example.com' });

  const { b: editor } = await staff('editor', { is_editor: true });
  const granted = await editor.call(admin, { method: 'POST', body: { action: 'allowance-grant', hours: 2, perHour: 100, label: 'Venue' } });
  assertKeys(granted, ['here', ...listOf('allowances', ALLOWANCE)]);
  assertKeys(await editor.call(admin), ['here', ...listOf('allowances', ALLOWANCE)]);
  const revoked = await editor.call(admin, { method: 'POST', body: { action: 'allowance-revoke', id: granted.json.allowances[0].id } });
  assertKeys(revoked, ['here', 'allowances']);

  const { b: boss } = await staff('boss', { is_admin: true });
  const added = await boss.call(admin, { method: 'POST', body: { action: 'filter-add', term: 'Pr1de Gu4rd' } });
  assertKeys(added, [...listOf('filters', FILTER), ...listOf('flagged', FLAGGED)]);
  assertKeys(await boss.call(admin), ['here', 'allowances', 'builtIn', ...listOf('filters', FILTER), ...listOf('flagged', FLAGGED)]);
  const removed = await boss.call(admin, { method: 'POST', body: { action: 'filter-remove', id: added.json.filters[0].id } });
  assertKeys(removed, ['filters', 'flagged']);
  assertKeys(await boss.call(admin, { method: 'POST', body: { action: 'reset-issue', username: 'pride_otter' } }), ['code', 'expiresAt']);
});

// ---------------------------------------------------------------------------
// The account page
// ---------------------------------------------------------------------------

test('the Security section answers only what it shows, and each passkey says when it was last used', async () => {
  const { b, id } = await member();
  linkTelegram(id);
  addPasskey(id, { label: 'Phone', created_at: '2026-10-01T00:00:00.000Z', last_used_at: '2026-11-01T08:00:00.000Z' });
  addPasskey(id, { label: 'Laptop', created_at: '2026-10-02T00:00:00.000Z' });
  const withPasskeys = [...SECURITY, ...listOf('passkeys', PASSKEY)];

  const summary = await b.call(security);
  assertKeys(summary, withPasskeys);
  assert.deepEqual(summary.json.passkeys.map((passkey) => [passkey.label, passkey.lastUsedAt]), [['Phone', '2026-11-01T08:00:00.000Z'], ['Laptop', null]]);

  const started = await b.call(security, { method: 'POST', body: { action: 'totp-start', password: PASSWORD } });
  assertKeys(started, ['setup', 'secret', 'uri']);
  const finished = await b.call(security, { method: 'POST', body: { action: 'totp-finish', setup: started.json.setup, code: totpAt(started.json.secret) } });
  assertKeys(finished, [...withPasskeys, 'codes']);
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'totp-remove', password: PASSWORD } }), withPasskeys);
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'passkey-options', password: PASSWORD } }), ['options'], ['options']);
  const laptop = summary.json.passkeys[1].id;
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'passkey-remove', id: laptop, password: PASSWORD } }), withPasskeys);
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'telegram-link' } }), ['url']);
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'telegram-unlink', password: PASSWORD } }), withPasskeys);
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'backup-regenerate', password: PASSWORD } }), ['codes']);
  assertKeys(await b.call(security, { method: 'POST', body: { action: 'delete-account', password: PASSWORD } }), ['deleted']);
});

test('the Notifications section answers only what it shows, and the test notice answers no count', async () => {
  const { b } = await member();
  assertKeys(await b.call(notifications), NOTIFY);
  assertKeys(await b.call(notifications, { method: 'POST', body: { action: 'prefs', newEvents: true } }), NOTIFY);
  assertKeys(await b.call(notifications, { method: 'POST', body: { action: 'subscribe', subscription } }), NOTIFY);
  assertKeys(await b.call(notifications, { method: 'POST', body: { action: 'test' } }), []);
  assertKeys(await b.call(notifications, { method: 'POST', body: { action: 'unsubscribe', endpoint: subscription.endpoint } }), NOTIFY);
});

test('a display name change answers the profile the page redraws, and the public config only the Turnstile key', async () => {
  const { b } = await member();
  assertKeys(await b.call(profile, { method: 'POST', body: { displayName: 'Sleepy Otter' } }), nest('user', USER));
  assertKeys(await on().call(config), ['turnstileSiteKey']);
});
