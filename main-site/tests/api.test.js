// Routes end to end against the in-memory database (fake-db.js), with
// Telegram's API replaced by a recorder. Staff accounts: the 2FA rule, sign
// in with a shared GFTV account, data minimisation on the public routes,
// RSVP and capacity, editor roles, the Telegram webhook, and the cross-site
// checks. Public accounts, notifications and covers are in public.test.js.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { browser, leaks, ORIGIN } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_BOT_USERNAME = 'HelloEventsTestBot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.CRON_SECRET = 'cron-test';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const login = (await import('../api/auth/login.js')).default;
const verify = (await import('../api/auth/verify.js')).default;
const sessionRoute = (await import('../api/auth/session.js')).default;
const feed = (await import('../api/events/feed.js')).default;
const detail = (await import('../api/events/detail.js')).default;
const rsvp = (await import('../api/events/rsvp.js')).default;
const manage = (await import('../api/manage/events.js')).default;
const security = (await import('../api/me/security.js')).default;
const rsvps = (await import('../api/me/rsvps.js')).default;
const webhook = (await import('../api/telegram/webhook.js')).default;
const cleanup = (await import('../api/cron/cleanup.js')).default;

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;
let sent;

// Telegram's Bot API, recorded rather than called.
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

async function addUser(over = {}) {
  const row = {
    username: over.username ?? `user${db.table('gftvhello_users').length}`,
    display_name: 'A Furry',
    email: `${over.username ?? db.table('gftvhello_users').length}@example.com`,
    password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true,
    ...over,
  };
  const { data } = await db.from('gftvhello_users').insert(row).select('id').single();
  return data.id;
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: over.slug ?? `event-${db.table('gftvevents_events').length + 1}`,
    title: 'Furmeet',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ends_at: null,
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

async function signIn(b, username) {
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return v;
}

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  sent = [];
});

// ---------------------------------------------------------------------------
// The 2FA gate
// ---------------------------------------------------------------------------

test('a staff account with no second factor is refused and told to use gftv.asia, as on OneLink', async () => {
  await addUser({ username: 'newfox' });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: 'newfox', password: PASSWORD } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'staff_needs_2fa');
  assert.equal(r.json.challenge, undefined);
  assert.equal(r.headers['set-cookie'], undefined, 'no cookie after the password alone');
  assert.equal(db.table('gftvevents_sessions').length, 0);
  assert.equal(db.table('gftvevents_auth_challenges').length, 0);
  assert.equal((await b.call(sessionRoute)).json.signedIn, false);
  // Nothing is ever written to the shared account.
  assert.equal(db.table('gftvhello_users')[0].totp_secret, null);
});

test('a staff session is a hashed cookie, and the staff account row is made on first sign-in', async () => {
  const id = await addUser({ username: 'firstfox', totp_secret: SHARED_SECRET });
  const b = browser();
  const v = await signIn(b, 'firstfox');
  assert.match(String(v.headers['set-cookie']), /^__Host-ghe_session=.+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict/);
  const cookie = b.jar.get('__Host-ghe_session');
  assert.equal(db.table('gftvevents_sessions')[0].token_hash, createHash('sha256').update(cookie).digest('hex'));
  const account = db.table('gftvevents_accounts').find((a) => a.id === id);
  assert.equal(account.kind, 'staff');
  assert.equal(account.staff_user_id, id);
  assert.deepEqual(leaks(v.json), []);
});

test('a staff account with an authenticator on gftv.asia signs in with it here', async () => {
  await addUser({ username: 'staffcat', totp_secret: SHARED_SECRET });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: 'StaffCat', password: PASSWORD } });
  assert.equal(r.json.step, 'verify');
  const bad = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: '123456' } });
  assert.equal(bad.json.error, 'code_wrong');
  const good = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(good.status, 200);
  assert.equal(good.json.user.username, 'staffcat');
  // A used challenge cannot be replayed.
  const replay = await browser().call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(replay.json.error, 'challenge_expired');
});

test('five wrong codes end the challenge', async () => {
  await addUser({ username: 'wolf', totp_secret: SHARED_SECRET });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: 'wolf', password: PASSWORD } });
  for (let i = 0; i < 5; i += 1) await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: '000000' } });
  const late = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(late.json.error, 'challenge_expired');
});

test('wrong password, unknown account and unapproved account', async () => {
  await addUser({ username: 'pending', is_approved: false, totp_secret: SHARED_SECRET });
  await addUser({ username: 'otter', totp_secret: SHARED_SECRET });
  const b = browser();
  assert.equal((await b.call(login, { method: 'POST', body: { identifier: 'otter', password: 'nope' } })).json.error, 'invalid_credentials');
  assert.equal((await b.call(login, { method: 'POST', body: { identifier: 'nobody', password: PASSWORD } })).json.error, 'invalid_credentials');
  const denied = await b.call(login, { method: 'POST', body: { identifier: 'pending', password: PASSWORD } });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error, 'no_access');
});

test('a shared backup code in the SHA-256 format works once and is spent', async () => {
  const id = await addUser({ username: 'bun', totp_secret: SHARED_SECRET });
  const code = 'ABCDE-12345';
  await db.from('gftvhello_backup_codes').insert({ user_id: id, code_hash: createHash('sha256').update('ABCDE12345').digest('hex') });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: 'bun', password: PASSWORD } });
  assert.equal(r.json.methods.backup, true);
  const ok = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'backup', code } });
  assert.equal(ok.status, 200);
  assert.equal(db.table('gftvhello_backup_codes').length, 0);
});

test('state-changing requests from another origin, or not JSON, are refused', async () => {
  const b = browser();
  const cross = await b.call(login, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error, 'bad_origin');
  const form = await b.call(login, { method: 'POST', body: {}, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
});

// ---------------------------------------------------------------------------
// Public routes: only released events, only allowed fields
// ---------------------------------------------------------------------------

test('the feed shows released events only, with hidden prices and dates kept back', async () => {
  addEvent({ slug: 'live-one', price_type: 'paid', price_min: 30, currency: 'SGD', price_hidden: true, staff_notes: 'secret note' });
  addEvent({ slug: 'a-draft', status: 'draft' });
  addEvent({ slug: 'not-yet', publish_at: new Date(Date.now() + 3600_000).toISOString() });
  addEvent({ slug: 'tba-one', dates_hidden: true, starts_at: '2027-05-01T00:00:00.000Z' });
  addEvent({ slug: 'over-one', starts_at: new Date(Date.now() - 86400_000).toISOString() });

  const b = browser();
  const upcoming = await b.call(feed, { query: { when: 'upcoming' } });
  assert.deepEqual(upcoming.json.events.map((e) => e.slug), ['live-one']);
  assert.deepEqual(upcoming.json.events[0].price, { type: 'tba' });
  assert.equal(JSON.stringify(upcoming.json).includes('secret note'), false);
  assert.equal(JSON.stringify(upcoming.json).includes('30'), false);
  assert.deepEqual(leaks(upcoming.json), []);
  assert.match(upcoming.headers['cache-control'], /s-maxage=60/);

  const tba = await b.call(feed, { query: { when: 'tba' } });
  assert.deepEqual(tba.json.events.map((e) => e.slug), ['tba-one']);
  assert.equal(JSON.stringify(tba.json).includes('2027-05-01'), false);

  const past = await b.call(feed, { query: { when: 'past' } });
  assert.deepEqual(past.json.events.map((e) => e.slug), ['over-one']);

  // Unreleased events answer exactly like missing ones.
  for (const slug of ['a-draft', 'not-yet', 'no-such-event']) {
    const r = await b.call(detail, { query: { slug } });
    assert.equal(r.status, 404, slug);
    assert.equal(r.json.error, 'not_found');
  }
});

test('editors may preview an unreleased event; members may not', async () => {
  addEvent({ slug: 'a-draft', status: 'draft' });
  await addUser({ username: 'editor', totp_secret: SHARED_SECRET, is_editor: true });
  await addUser({ username: 'member', totp_secret: SHARED_SECRET });
  const ed = browser();
  await signIn(ed, 'editor');
  const r = await ed.call(detail, { query: { slug: 'a-draft' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.preview, true);
  const mem = browser();
  await signIn(mem, 'member');
  assert.equal((await mem.call(detail, { query: { slug: 'a-draft' } })).status, 404);
});

// ---------------------------------------------------------------------------
// RSVP
// ---------------------------------------------------------------------------

test('RSVP needs a session, respects capacity, and reveals the online link only to people going', async () => {
  const event = addEvent({ slug: 'small-meet', capacity: 1, is_online: true, online_url: 'https://meet.example.com/abc', address_attendees_only: true, venue_address: '1 Hidden Lane' });
  await addUser({ username: 'first', totp_secret: SHARED_SECRET });
  await addUser({ username: 'second', totp_secret: SHARED_SECRET });

  const anon = browser();
  const refused = await anon.call(rsvp, { method: 'POST', body: { slug: 'small-meet', going: true } });
  assert.equal(refused.status, 401);
  const anonView = await anon.call(detail, { query: { slug: 'small-meet' } });
  assert.equal(JSON.stringify(anonView.json).includes('meet.example.com'), false);
  assert.equal(JSON.stringify(anonView.json).includes('Hidden Lane'), false);

  const a = browser();
  await signIn(a, 'first');
  const going = await a.call(rsvp, { method: 'POST', body: { slug: 'small-meet', going: true } });
  assert.equal(going.status, 200);
  assert.equal(going.json.event.where.onlineUrl, 'https://meet.example.com/abc');
  assert.equal(going.json.event.where.address, '1 Hidden Lane');
  assert.equal(going.json.event.going, 1);
  assert.deepEqual(leaks(going.json), []);

  const b = browser();
  await signIn(b, 'second');
  const full = await b.call(rsvp, { method: 'POST', body: { slug: 'small-meet', going: true } });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'event_full');

  const mine = await a.call(rsvps);
  assert.deepEqual(mine.json.upcoming.map((r) => r.event.slug), ['small-meet']);

  await a.call(rsvp, { method: 'POST', body: { slug: 'small-meet', going: false } });
  assert.equal(db.table('gftvevents_attendees').filter((r) => r.event_id === event.id).length, 0);
  assert.equal((await b.call(rsvp, { method: 'POST', body: { slug: 'small-meet', going: true } })).status, 200);
});

test('drafts and cancelled events cannot be joined', async () => {
  addEvent({ slug: 'draft-one', status: 'draft' });
  addEvent({ slug: 'cancelled-one', status: 'cancelled' });
  await addUser({ username: 'fox', totp_secret: SHARED_SECRET });
  const b = browser();
  await signIn(b, 'fox');
  assert.equal((await b.call(rsvp, { method: 'POST', body: { slug: 'draft-one', going: true } })).status, 404);
  assert.equal((await b.call(rsvp, { method: 'POST', body: { slug: 'cancelled-one', going: true } })).json.error, 'rsvp_closed');
});

// ---------------------------------------------------------------------------
// Managing events
// ---------------------------------------------------------------------------

test('members cannot manage; editors create and edit; only admins delete', async () => {
  await addUser({ username: 'member', totp_secret: SHARED_SECRET });
  await addUser({ username: 'editor', totp_secret: SHARED_SECRET, is_editor: true });
  await addUser({ username: 'admin', totp_secret: SHARED_SECRET, is_admin: true });

  const mem = browser();
  await signIn(mem, 'member');
  const no = await mem.call(manage);
  assert.equal(no.status, 403);
  assert.equal(no.json.error, 'manage_only');

  const ed = browser();
  await signIn(ed, 'editor');
  const made = await ed.call(manage, {
    method: 'POST',
    body: {
      action: 'create',
      event: { title: 'Mega Con', kind: 'convention', status: 'published', timezone: 'Asia/Singapore', startsLocal: '2030-01-01T10:00', priceType: 'free', staffNotes: 'budget 5k', created_by: 'forged' },
    },
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.event.slug, 'mega-con');
  assert.equal(made.json.event.staffNotes, 'budget 5k');
  assert.deepEqual(leaks(made.json), []);
  const row = db.table('gftvevents_events').find((e) => e.slug === 'mega-con');
  assert.notEqual(row.created_by, 'forged');

  const dup = await ed.call(manage, { method: 'POST', body: { action: 'create', event: { title: 'Mega Con', kind: 'convention', status: 'draft', startsLocal: '2030-01-01T10:00', priceType: 'free' } } });
  assert.equal(dup.json.error, 'slug_taken');

  const bad = await ed.call(manage, { method: 'POST', body: { action: 'update', id: row.id, event: { title: '', kind: 'convention', status: 'draft', priceType: 'free' } } });
  assert.equal(bad.json.error, 'invalid_field');
  assert.equal(bad.json.field, 'title');

  // The public page has none of the editor-only fields.
  const pub = await browser().call(detail, { query: { slug: 'mega-con' } });
  assert.equal(JSON.stringify(pub.json).includes('budget 5k'), false);

  assert.equal((await ed.call(manage, { method: 'POST', body: { action: 'delete', id: row.id } })).json.error, 'admin_only');
  const ad = browser();
  await signIn(ad, 'admin');
  assert.equal((await ad.call(manage, { method: 'POST', body: { action: 'delete', id: row.id } })).status, 200);
  assert.equal(db.table('gftvevents_events').length, 0);
});

test('an editor role revoked on gftv.asia takes effect on the next request', async () => {
  const id = await addUser({ username: 'editor', totp_secret: SHARED_SECRET, is_editor: true });
  const ed = browser();
  await signIn(ed, 'editor');
  assert.equal((await ed.call(manage)).status, 200);
  db.table('gftvhello_users').find((u) => u.id === id).is_editor = false;
  assert.equal((await ed.call(manage)).status, 403);
  db.table('gftvhello_users').find((u) => u.id === id).is_approved = false;
  assert.equal((await ed.call(sessionRoute)).json.signedIn, false);
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function update(text, chatId = 4242) {
  return { message: { chat: { id: chatId, type: 'private' }, from: { username: 'foxgram' }, text } };
}

test('the webhook refuses calls without the secret token header', async () => {
  const b = browser();
  const none = await b.call(webhook, { method: 'POST', body: update('/start'), headers: {} });
  assert.equal(none.status, 401);
  const wrong = await b.call(webhook, { method: 'POST', body: update('/start'), headers: { 'x-telegram-bot-api-secret-token': 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(sent.length, 0);
});

test('linking Telegram from the account page, then signing in with it', async () => {
  const userId = await addUser({ username: 'tgfox', totp_secret: SHARED_SECRET });
  const b = browser();
  await signIn(b, 'tgfox');
  const link = await b.call(security, { method: 'POST', body: { action: 'telegram-link' } });
  assert.match(link.json.url, /^https:\/\/t\.me\/HelloEventsTestBot\?start=/);
  const token = new URL(link.json.url).searchParams.get('start');

  const hook = await browser().call(webhook, { method: 'POST', body: update(`/start ${token}`), headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' } });
  assert.equal(hook.status, 200);
  assert.equal(db.table('gftvevents_telegram_links')[0].user_id, userId);
  assert.equal(db.table('gftvevents_telegram_links')[0].chat_id, 4242);

  // A spent link token does nothing the second time.
  sent = [];
  await browser().call(webhook, { method: 'POST', body: update(`/start ${token}`, 9999), headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' } });
  assert.match(sent[0].body.text, /expired or was already used/);

  sent = [];
  const again = browser();
  const r2 = await again.call(login, { method: 'POST', body: { identifier: 'tgfox', password: PASSWORD } });
  assert.equal(r2.json.methods.telegram, true);
  await again.call(verify, { method: 'POST', body: { challenge: r2.json.challenge, method: 'telegram-send' } });
  const message = sent.find((m) => m.url.endsWith('/sendRichMessage'));
  assert.ok(message, 'sent with sendRichMessage');
  assert.equal('parse_mode' in message.body, false);
  assert.match(message.body.rich_message.markdown, /## Sign-in code/);
  const code = message.body.rich_message.markdown.match(/`(\d{6})`/)[1];
  const v = await again.call(verify, { method: 'POST', body: { challenge: r2.json.challenge, method: 'telegram', code } });
  assert.equal(v.status, 200);
  const sec = await again.call(security);
  assert.equal(sec.json.telegram.linked, true);
  assert.equal(JSON.stringify(sec.json).includes('4242'), false, 'chat id never sent');
});

test('the last second factor cannot be removed', async () => {
  const id = await addUser({ username: 'solo', totp_secret: null });
  db.table('gftvevents_telegram_links').push({ user_id: id, chat_id: 1, telegram_username: 'solo', linked_at: new Date().toISOString() });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: 'solo', password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'telegram-send' } });
  const code = sent[0].body.rich_message.markdown.match(/`(\d{6})`/)[1];
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'telegram', code } });
  const unlink = await b.call(security, { method: 'POST', body: { action: 'telegram-unlink', password: PASSWORD } });
  assert.equal(unlink.status, 409);
  assert.equal(unlink.json.error, 'last_factor');
});

test('the cleanup cron needs its secret', async () => {
  const b = browser();
  assert.equal((await b.call(cleanup, { headers: {} })).status, 401);
  const ok = await b.call(cleanup, { headers: { authorization: 'Bearer cron-test' } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.json.swept.sessions, 'number');
  assert.equal(ORIGIN, 'https://events.globalfurry.tv');
});
