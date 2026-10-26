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

const rules = await import('../api/_lib/event-rules.js');
const ser = await import('../api/_lib/serialize.js');
const totp = await import('../api/_lib/totp.js');
const crypto = await import('../api/_lib/crypto.js');
const tg = await import('../api/_lib/telegram.js');
const msgs = await import('../api/_lib/telegram-messages.js');
const users = await import('../api/_lib/users.js');

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
  const r = rules.validateEvent(form({ created_by: 'x', id: 'y', staff_only: true, gftvevents_attendees: [] }));
  assert.equal(r.ok, true);
  for (const key of ['created_by', 'id', 'staff_only', 'gftvevents_attendees']) assert.equal(key in r.fields, false, key);
});

test('bad input is refused with the field named', () => {
  assert.deepEqual(rules.validateEvent(form({ title: '' })), { ok: false, error: 'invalid_field', field: 'title' });
  assert.equal(rules.validateEvent(form({ slug: 'Bad Slug!' })).field, 'slug');
  assert.equal(rules.validateEvent(form({ kind: 'party' })).field, 'kind');
  assert.equal(rules.validateEvent(form({ endsLocal: '2027-02-01T10:00' })).field, 'endsLocal');
  assert.equal(rules.validateEvent(form({ startsLocal: '' })).field, 'startsLocal');
  assert.equal(rules.validateEvent(form({ coverImageUrl: 'http://example.com/a.png' })).field, 'coverImageUrl');
  assert.equal(rules.validateEvent(form({ coverImageUrl: 'javascript:alert(1)' })).field, 'coverImageUrl');
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
  const card = ser.publicEventCard(row({ price_hidden: true }), now);
  assert.deepEqual(card.price, { type: 'tba' });
  assert.equal(json(card).includes('25'), false);
  assert.equal(json(card).includes('SGD'), false);
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

test('an attendee is a name and username, never an email or id', () => {
  const view = ser.attendeeView({ created_at: 'x', user: { id: 'u1', username: 'fox', display_name: 'Fox', email: 'fox@example.com' } });
  assert.deepEqual(Object.keys(view).sort(), ['displayName', 'rsvpAt', 'username']);
});

test('the signed-in view of yourself has no secrets', () => {
  const view = ser.selfView({
    id: 'u1', username: 'fox', display_name: 'Fox', email: 'fox@example.com', password_hash: '$2a$', totp_secret: 'ABC',
    is_admin: false, is_editor: true, is_approved: true, avatar_url: 'http://insecure.example/a.png',
  });
  assert.deepEqual(view, { username: 'fox', displayName: 'Fox', avatarUrl: null, role: 'editor', canManage: true });
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
  assert.equal(users.canSignIn({ is_approved: false, is_admin: true }), false);
  assert.equal(users.canManage({ is_approved: true, is_editor: false, is_admin: false }), false);
  assert.equal(users.canManage({ is_approved: true, is_editor: true }), true);
  assert.equal(users.isAdmin({ is_approved: true, is_admin: true }), true);
  assert.equal(users.roleOf({ is_approved: true }), 'member');
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
