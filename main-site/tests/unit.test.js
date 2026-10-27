// Unit tests for the pure parts: event rules, time zones, the data
// minimisation serializers, TOTP, backup codes, the secret envelope and the
// Telegram message builders. No database and no network.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SITE_URL = 'https://events.globalfurry.tv';
process.env.SUPABASE_URL = 'https://project.supabase.co';

const rules = await import('../api/_lib/event-rules.js');
const ser = await import('../api/_lib/serialize.js');
const totp = await import('../api/_lib/totp.js');
const crypto = await import('../api/_lib/crypto.js');
const tg = await import('../api/_lib/telegram.js');
const msgs = await import('../api/_lib/telegram-messages.js');
const users = await import('../api/_lib/users.js');
const acct = await import('../api/_lib/account-rules.js');
const push = await import('../api/_lib/push.js');
const covers = await import('../api/_lib/covers.js');
const notify = await import('../api/_lib/notify.js');
const names = await import('../api/_lib/name-filter.js');
const { default: sharp } = await import('sharp');

const HOUR = 3600_000;
const now = Date.parse('2026-10-26T12:00:00Z');

function row(over = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'sg-furmeet',
    title: 'SG Furmeet',
    kind: 'furmeet',
    summary: 'A meet',
    description: 'Long text',
    status: 'published',
    publish_at: null,
    starts_at: '2026-11-14T06:00:00.000Z',
    ends_at: '2026-11-14T10:00:00.000Z',
    timezone: 'Asia/Singapore',
    dates_hidden: false,
    is_online: false,
    online_url: null,
    venue_name: 'Hall',
    venue_address: '1 Secret Road',
    address_attendees_only: false,
    city: 'Singapore',
    country: 'Singapore',
    cover_image_url: null,
    price_type: 'paid',
    price_min: 25,
    price_max: 40,
    currency: 'SGD',
    price_note: null,
    price_hidden: false,
    capacity: 10,
    rsvp_open: true,
    organiser_name: 'GFTV',
    external_url: null,
    staff_notes: 'internal only',
    created_by: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    gftvevents_attendees: [{ count: 3 }],
    ...over,
  };
}

const json = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// Release rules
// ---------------------------------------------------------------------------

test('only published or cancelled events past their release time are released', () => {
  assert.equal(rules.isReleased(row(), now), true);
  assert.equal(rules.isReleased(row({ status: 'cancelled' }), now), true);
  assert.equal(rules.isReleased(row({ status: 'draft' }), now), false);
  assert.equal(rules.isReleased(row({ publish_at: new Date(now + HOUR).toISOString() }), now), false);
  assert.equal(rules.isReleased(row({ publish_at: new Date(now - HOUR).toISOString() }), now), true);
});

test('releasedFilter filters status and release time in the query', () => {
  const calls = [];
  const q = { in: (...a) => (calls.push(['in', ...a]), q), or: (...a) => (calls.push(['or', ...a]), q) };
  rules.releasedFilter(q, '2026-10-26T12:00:00.000Z');
  assert.deepEqual(calls[0], ['in', 'status', ['published', 'cancelled']]);
  assert.equal(calls[1][1], 'publish_at.is.null,publish_at.lte."2026-10-26T12:00:00.000Z"');
});

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

test('wall-clock times convert to UTC and back in the event zone', () => {
  assert.equal(rules.wallToUtc('2026-11-14T14:00', 'Asia/Singapore'), '2026-11-14T06:00:00.000Z');
  assert.equal(rules.utcToWall('2026-11-14T06:00:00.000Z', 'Asia/Singapore'), '2026-11-14T14:00');
  for (const tz of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata']) {
    for (const wall of ['2026-01-15T09:30', '2026-07-01T23:45', '2026-12-31T00:00']) {
      assert.equal(rules.utcToWall(rules.wallToUtc(wall, tz), tz), wall, `${tz} ${wall}`);
    }
  }
  assert.equal(rules.wallToUtc('2026-13-01T00:00', 'Asia/Singapore'), null);
  assert.equal(rules.wallToUtc('2026-11-14T14:00', 'Not/AZone'), null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const form = (over = {}) => ({
  title: 'Big Con 2027',
  kind: 'convention',
  status: 'draft',
  timezone: 'Asia/Singapore',
  startsLocal: '2027-03-01T10:00',
  endsLocal: '2027-03-02T18:00',
  priceType: 'free',
  ...over,
});

test('a good event validates and gets a slug from its title', () => {
  const r = rules.validateEvent(form());
  assert.equal(r.ok, true);
  assert.equal(r.fields.slug, 'big-con-2027');
  assert.equal(r.fields.starts_at, '2027-03-01T02:00:00.000Z');
  assert.equal(r.fields.price_min, null);
});

test('unknown fields never reach the table', () => {
  const r = rules.validateEvent(form({ created_by: 'x', id: 'y', staff_only: true, gftvevents_attendees: [], coverImageUrl: 'https://evil.example/x.png', cover_image_path: 'x' }));
  assert.equal(r.ok, true);
  for (const key of ['created_by', 'id', 'staff_only', 'gftvevents_attendees', 'cover_image_url', 'cover_image_path']) assert.equal(key in r.fields, false, key);
});

test('bad input is refused with the field named', () => {
  assert.deepEqual(rules.validateEvent(form({ title: '' })), { ok: false, error: 'invalid_field', field: 'title' });
  assert.equal(rules.validateEvent(form({ slug: 'Bad Slug!' })).field, 'slug');
  assert.equal(rules.validateEvent(form({ kind: 'party' })).field, 'kind');
  assert.equal(rules.validateEvent(form({ endsLocal: '2027-02-01T10:00' })).field, 'endsLocal');
  assert.equal(rules.validateEvent(form({ startsLocal: '' })).field, 'startsLocal');
  assert.equal(rules.validateEvent(form({ externalUrl: 'http://example.com/a' })).field, 'externalUrl');
  assert.equal(rules.validateEvent(form({ onlineUrl: 'javascript:alert(1)' })).field, 'onlineUrl');
  assert.equal(rules.validateEvent(form({ externalUrl: 'https://user:pw@example.com' })).field, 'externalUrl');
  assert.equal(rules.validateEvent(form({ priceType: 'paid' })).field, 'priceMin');
  assert.equal(rules.validateEvent(form({ priceType: 'paid', priceMin: '20', priceMax: '10' })).field, 'priceMax');
  assert.equal(rules.validateEvent(form({ capacity: '0' })).field, 'capacity');
  assert.equal(rules.validateEvent(form({ title: 'x'.repeat(121) })).field, 'title');
});

test('dates to be announced may leave the start empty', () => {
  const r = rules.validateEvent(form({ startsLocal: '', endsLocal: '', datesHidden: true }));
  assert.equal(r.ok, true);
  assert.equal(r.fields.starts_at, null);
});

// ---------------------------------------------------------------------------
// Data minimisation (help desk #7)
// ---------------------------------------------------------------------------

test('public cards and pages never carry staff notes, ids, creators or raw columns', () => {
  const card = ser.publicEventCard(row(), now);
  const detail = ser.publicEventDetail(row(), { signedIn: true }, now);
  for (const view of [card, detail]) {
    const text = json(view);
    assert.equal(text.includes('internal only'), false);
    assert.equal(text.includes('22222222'), false, 'creator id');
    assert.equal(text.includes('11111111'), false, 'event id');
    for (const column of ['staff_notes', 'created_by', 'publish_at', 'price_hidden', 'gftvevents_attendees', 'status']) {
      assert.equal(column in view, false, column);
    }
  }
});

test('a hidden price goes out as "to be announced", without the amounts', () => {
  const card = ser.publicEventCard(row({ price_hidden: true, price_min: 98765.43, price_max: 98999, currency: 'XTS' }), now);
  assert.deepEqual(card.price, { type: 'tba' });
  assert.equal(json(card).includes('98765'), false);
  assert.equal(json(card).includes('XTS'), false);
});

test('dates to be announced go out without the stored dates', () => {
  const card = ser.publicEventCard(row({ dates_hidden: true }), now);
  assert.deepEqual(card.when, { tba: true, timezone: 'Asia/Singapore' });
  assert.equal(json(card).includes('2026-11-14'), false);
});

test('attendees-only address and the online link go only to people going and editors', () => {
  const r = row({ address_attendees_only: true, is_online: true, online_url: 'https://meet.example.com/x' });
  const stranger = ser.publicEventDetail(r, { signedIn: true, going: false }, now);
  assert.equal(stranger.where.address, null);
  assert.equal(stranger.where.onlineUrl, null);
  assert.equal(stranger.where.addressForAttendees, true);
  assert.equal(json(stranger).includes('Secret Road'), false);
  assert.equal(json(stranger).includes('meet.example.com'), false);

  const going = ser.publicEventDetail(r, { signedIn: true, going: true }, now);
  assert.equal(going.where.address, '1 Secret Road');
  assert.equal(going.where.onlineUrl, 'https://meet.example.com/x');

  const editor = ser.publicEventDetail(r, { signedIn: true, canManage: true }, now);
  assert.equal(editor.where.address, '1 Secret Road');
});

test('RSVP state and spaces come from the count', () => {
  assert.equal(ser.publicEventCard(row(), now).rsvp, 'open');
  assert.equal(ser.publicEventCard(row(), now).left, 7);
  assert.equal(ser.publicEventCard(row({ gftvevents_attendees: [{ count: 10 }] }), now).rsvp, 'full');
  assert.equal(ser.publicEventCard(row({ status: 'cancelled' }), now).rsvp, 'cancelled');
  assert.equal(ser.publicEventCard(row({ rsvp_open: false }), now).rsvp, 'closed');
  assert.equal(ser.publicEventCard(row({ starts_at: '2026-10-01T00:00:00Z', ends_at: null }), now).rsvp, 'over');
});

test('an attendee is a name, a username and staff or not, never an email or id', () => {
  const staff = ser.attendeeView({ user_id: 'u1', created_at: 'x', account: { kind: 'staff', id: 'u1', staff: { id: 'u1', username: 'fox', display_name: 'Fox', email: 'fox@example.com' } } });
  assert.deepEqual(Object.keys(staff).sort(), ['displayName', 'rsvpAt', 'staff', 'username']);
  assert.equal(staff.staff, true);
  const member = ser.attendeeView({ user_id: 'p1', created_at: 'x', account: { kind: 'public', id: 'p1', username: 'otter', display_name: 'Otter', email: 'otter@example.com' } });
  assert.deepEqual(member, { username: 'otter', displayName: 'Otter', staff: false, rsvpAt: 'x' });
  assert.equal(JSON.stringify(member).includes('example.com'), false);
});

test('the signed-in view of yourself has no secrets', () => {
  const view = ser.selfView({
    id: 'u1', kind: 'staff', username: 'fox', display_name: 'Fox', email: 'fox@example.com', password_hash: '$2a$', totp_secret: 'ABC',
    is_admin: false, is_editor: true, is_approved: true, avatar_url: 'http://insecure.example/a.png',
  });
  assert.deepEqual(view, { username: 'fox', displayName: 'Fox', avatarUrl: null, kind: 'staff', role: 'editor', canManage: true });
  const member = ser.selfView({ id: 'p1', kind: 'public', username: 'otter', display_name: 'Otter', is_approved: true, password_hash: '$2a$' });
  assert.deepEqual(member, { username: 'otter', displayName: 'Otter', avatarUrl: null, kind: 'public', role: 'member', canManage: false });
});

test('a public account can never manage events, whatever its row says', () => {
  assert.equal(users.canManage({ kind: 'public', is_approved: true, is_admin: true, is_editor: true }), false);
  assert.equal(users.secondFactorRequired({ kind: 'staff' }), true);
  assert.equal(users.secondFactorRequired({ kind: 'public' }), false);
});

test('the editor view round-trips the form fields, including staff notes', () => {
  const view = ser.managedEvent(row(), now);
  assert.equal(view.staffNotes, 'internal only');
  assert.equal(view.startsLocal, '2026-11-14T14:00');
  const again = rules.validateEvent(view);
  assert.equal(again.ok, true);
  assert.equal(again.fields.starts_at, row().starts_at);
});

test('no route sends a database result straight out', () => {
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
  const files = (function walk(dir) {
    return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  })(api).filter((f) => f.endsWith('.js') && !f.includes('_lib'));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // ok(res, data) / ok(res, row) / ok(res, { ...data }) would pass rows through.
    assert.doesNotMatch(src, /\bok\(res,\s*(data|row|rows|fresh|event)\s*\)/, file);
    assert.doesNotMatch(src, /\bok\(res,\s*\{\s*\.\.\.(data|row)\b/, file);
    assert.doesNotMatch(src, /res\.json\(/, file);
  }
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test('roles follow is_approved, is_editor and is_admin', () => {
  assert.equal(users.canSignIn({ kind: 'staff', is_approved: false, is_admin: true }), false);
  assert.equal(users.canManage({ kind: 'staff', is_approved: true, is_editor: false, is_admin: false }), false);
  assert.equal(users.canManage({ kind: 'staff', is_approved: true, is_editor: true }), true);
  assert.equal(users.isAdmin({ kind: 'staff', is_approved: true, is_admin: true }), true);
  assert.equal(users.roleOf({ kind: 'staff', is_approved: true }), 'staff');
  assert.equal(users.roleOf({ kind: 'public', is_approved: true }), 'member');
});

// ---------------------------------------------------------------------------
// TOTP, codes and secrets
// ---------------------------------------------------------------------------

test('TOTP matches RFC 6238 and accepts one step of drift', () => {
  // RFC 6238 appendix B, SHA-1 seed "12345678901234567890", last six digits.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp.totpAt(secret, 59_000), '287082');
  assert.equal(totp.totpAt(secret, 1111111109_000), '081804');
  assert.equal(totp.verifyTotp('081804', secret, 1111111109_000 + 30_000), true);
  assert.equal(totp.verifyTotp('081804', secret, 1111111109_000 + 90_000), false);
  assert.equal(totp.verifyTotp('12345', secret), false);
});

test('a generated TOTP secret is base32 and verifies', () => {
  const secret = totp.generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(totp.verifyTotp(totp.totpAt(secret), secret), true);
  assert.match(totp.otpauthUri({ account: 'fox', secret }), /^otpauth:\/\/totp\/GFTV%20HelloEvents:fox\?secret=/);
});

test('backup codes are ten readable codes that match however they are typed', async () => {
  const codes = crypto.generateBackupCodes();
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^[23456789a-hjkmnp-z]{5}-[23456789a-hjkmnp-z]{5}$/);
  const rows = [{ id: 1, code_hash: await crypto.hashCode(codes[0]) }];
  assert.equal((await crypto.findMatchingCode(codes[0].toUpperCase().replace('-', ' '), rows))?.id, 1);
  assert.equal(await crypto.findMatchingCode('wrong-codex', rows), null);
});

test('the secret envelope round-trips and refuses tampering', () => {
  const env = crypto.encryptSecret('JBSWY3DPEHPK3PXP');
  assert.match(env, /^v1:/);
  assert.equal(crypto.decryptSecret(env), 'JBSWY3DPEHPK3PXP');
  const parts = env.split(':');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.equal(crypto.decryptSecret(parts.join(':')), null);
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

test('rich markdown escapes data, including table pipes and formulas', () => {
  assert.equal(tg.escapeMd('a_b*c|d$e<f'), 'a\\_b\\*c\\|d\\$e\\<f');
  assert.equal(tg.escapeCell('two\nlines'), 'two lines');
  const table = tg.richTable(['Detail'], [['Account', 'fox_|_tail']]);
  assert.equal(table.split('\n')[2], '| Account | fox\\_\\|\\_tail |');
});

test('every rich message carries a plain fallback with the same code', () => {
  const m = msgs.codeMessage({ purpose: 'sign-in', username: 'fox_tail', code: '123456', minutes: 5 });
  assert.ok(m.fallback.includes('123456'));
  assert.ok(m.markdown.includes('`123456`'));
  assert.ok(m.markdown.includes('fox\\_tail'));
  assert.equal(m.skipEntities, true);
  assert.ok(msgs.helpMessage().fallback.length > 20);
});

// ---------------------------------------------------------------------------
// Public accounts (round 3)
// ---------------------------------------------------------------------------

const signup = (over = {}) => ({ username: 'Snow_Fox', displayName: '  Snow   Fox ', email: ' Snow@Example.com ', password: 'a long enough secret', agree: true, ...over });

test('sign-up input is cleaned and checked', () => {
  const r = acct.validateSignup(signup());
  assert.deepEqual(r, { ok: true, fields: { username: 'snow_fox', displayName: 'Snow Fox', email: 'snow@example.com' } });
  assert.equal(acct.validateSignup(signup({ username: 'ab' })).error, 'username_invalid');
  assert.equal(acct.validateSignup(signup({ displayName: '\u200b' })).error, 'display_name_invalid');
  assert.equal(acct.validateSignup(signup({ email: 'not-an-email' })).error, 'email_invalid');
  assert.equal(acct.validateSignup(signup({ password: 'short' })).error, 'password_short');
  assert.equal(acct.validateSignup(signup({ password: 'é'.repeat(40) })).error, 'password_long');
  assert.equal(acct.validateSignup(signup({ username: 'snow_fox_12', password: 'Snow_Fox_12' })).error, 'password_weak', 'password equals username');
  assert.equal(acct.validateSignup(signup({ password: 'snow@example.com' })).error, 'password_weak', 'password equals email');
  assert.equal(acct.validateSignup(signup({ password: 'aaaaaaaaaaaa' })).error, 'password_weak');
  assert.equal(acct.validateSignup(signup({ agree: 'yes' })).error, 'terms_required');
});

// ---------------------------------------------------------------------------
// Push subscriptions
// ---------------------------------------------------------------------------

const keys = { p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) };

test('push endpoints must be a real browser push service (no SSRF)', () => {
  assert.equal(push.checkSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }).ok, true);
  assert.equal(push.checkSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys }).ok, true);
  assert.equal(push.checkSubscription({ endpoint: 'https://web.push.apple.com/QH', keys }).ok, true);
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
  ]) {
    assert.equal(push.checkSubscription({ endpoint, keys }).ok, false, endpoint);
  }
  assert.equal(push.checkSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: keys.auth } }).error, 'push_invalid');
  const clean = push.checkSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys, expirationTime: 1, extra: 'dropped' });
  assert.deepEqual(Object.keys(clean.subscription).sort(), ['endpoint', 'keys']);
});

// ---------------------------------------------------------------------------
// Cover pictures
// ---------------------------------------------------------------------------

const picture = (w, h, format) => sharp({ create: { width: w, height: h, channels: 3, background: '#3fa7d6' } })[format]().toBuffer();
const b64 = (buf, type = 'image/webp') => `data:${type};base64,${buf.toString('base64')}`;

test('a cover must be a real WebP within size and dimension limits', async () => {
  const good = await covers.prepareCover(b64(await picture(1600, 900, 'webp')));
  assert.equal(good.ok, true);
  assert.equal(good.buffer.toString('ascii', 8, 12), 'WEBP');
  const big = await covers.prepareCover(b64(await picture(2400, 1200, 'webp')));
  assert.equal(big.ok, true);
  assert.equal(big.width, 1600, 'stored at most 1600 wide');
  assert.equal((await covers.prepareCover(b64(await picture(800, 450, 'png'), 'image/png'))).error, 'cover_not_webp');
  assert.equal((await covers.prepareCover(b64(await picture(800, 450, 'png')))).error, 'cover_not_webp', 'a PNG labelled as WebP');
  assert.equal((await covers.prepareCover(b64(await picture(2500, 900, 'webp')))).error, 'cover_too_big');
  assert.equal((await covers.prepareCover(b64(await picture(300, 200, 'webp')))).error, 'cover_too_small');
  const fake = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(64)]);
  assert.equal((await covers.prepareCover(b64(fake))).error, 'cover_invalid');
  assert.equal((await covers.prepareCover('data:image/webp;base64,' + 'A'.repeat(1_400_000))).error, 'cover_too_large');
  assert.equal((await covers.prepareCover('not base64 !!')).error, 'cover_invalid');
});

test('cover addresses are built from the stored path only', () => {
  const path = '11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuv.webp';
  assert.equal(covers.coverUrl(path), `https://project.supabase.co/storage/v1/object/public/gftvevents_covers/${path}`);
  assert.equal(covers.coverUrl('../../etc/passwd'), null);
  assert.equal(covers.coverUrl(null), null);
  assert.equal(ser.publicEventCard(row({ cover_image_path: path, cover_image_url: 'https://old.example/a.png' }), now).coverImageUrl, covers.coverUrl(path));
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test('only a change of time or place, or a cancellation, of a released event is announced', () => {
  const live = row();
  assert.equal(notify.changeKind(live, { ...live, title: 'New title' }), null);
  assert.equal(notify.changeKind(live, { ...live, starts_at: '2026-11-15T06:00:00.000Z' }), 'updated');
  assert.equal(notify.changeKind(live, { ...live, venue_name: 'Other Hall' }), 'updated');
  assert.equal(notify.changeKind(live, { ...live, status: 'cancelled' }), 'cancelled');
  assert.equal(notify.changeKind(row({ status: 'draft' }), row({ status: 'draft', venue_name: 'X' })), null);
  assert.equal(notify.changeKind(live, { ...live, status: 'draft', venue_name: 'X' }), null, 'unpublished: nothing goes out');
  assert.equal(notify.changeKind(live, { ...live, starts_at: '2026-11-14T06:00:00Z' }), null, 'same instant, other spelling');
});

test('a notice carries public fields only', () => {
  const r = row({ is_online: true, online_url: 'https://meet.example.com/secret', venue_address: '1 Secret Road', address_attendees_only: true });
  for (const kind of ['updated', 'cancelled', 'reminder', 'new']) {
    const n = notify.noticeFor(kind, r);
    const text = JSON.stringify(n);
    assert.equal(text.includes('meet.example.com'), false, kind);
    assert.equal(text.includes('Secret Road'), false, kind);
    assert.equal(text.includes('internal only'), false, kind);
    assert.equal(n.url, 'https://events.globalfurry.tv/e/sg-furmeet');
  }
  assert.ok(notify.noticeFor('reminder', row({ dates_hidden: true })).lines.includes('Dates to be announced'));
});

// ---------------------------------------------------------------------------
// Name filter (round 4)
// ---------------------------------------------------------------------------

test('names that look like staff are caught through case, spacing, accents, leetspeak and look-alikes', () => {
  for (const name of ['Staff', 'GFTV Staff', 'S.T.A.F.F', 's t a f f', '5taff', '$taff', 'St\u00e4ff', '\u0405taff', 'Off1c1al', '0FFICIAL', '\u043e\u0066ficial',
    'gftv_fan', 'G F T V', 'gf7v', 'Global Furry', 'The Admin', 'adm1n', '4dmin', 'Moderator Wolf', 'Mod', 'm0d', 'Mods Team', 'HelloEvents Team', 'S\u200btaff']) {
    assert.ok(names.blockedTerm(name), name);
  }
  for (const name of ['Snow Fox', 'Admiral Otter', 'Modesty', 'Devon', 'Gmail Fox', 'Stuffed Bear', 'Moddy']) {
    assert.equal(names.blockedTerm(name), null, name);
  }
});

test('the admin list matches the same way, by its folded form', () => {
  assert.equal(names.fold('Pr1de Gu4rd'), 'prideguard');
  assert.equal(names.blockedTerm('The PRIDE guard', ['prideguard']), 'prideguard');
  assert.equal(names.blockedTerm('pr!de_gu@rd', ['prideguard']), 'prideguard');
  assert.equal(names.blockedTerm('Pride parade', ['prideguard']), null);
  assert.equal(names.blockedTerm('xx', ['x']), null, 'words under 3 letters are ignored');
});

test('an admin reset code is three groups of five unambiguous characters', () => {
  const code = crypto.randomBytesCode();
  assert.match(code, /^[23456789a-hjkmnp-z]{5}-[23456789a-hjkmnp-z]{5}-[23456789a-hjkmnp-z]{5}$/);
  assert.notEqual(crypto.randomBytesCode(), code);
});
