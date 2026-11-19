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
    description_zh: '长文',
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
  description: 'All about it.',
  descriptionZh: '关于大会。',
  kind: 'convention',
  status: 'draft',
  timezone: 'Asia/Singapore',
  startDate: '2027-03-01',
  startTime: '10:00',
  endDate: '2027-03-02',
  endTime: '18:00',
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
  assert.equal(rules.validateEvent(form({ endDate: '2027-02-01' })).field, 'endDate');
  assert.equal(rules.validateEvent(form({ endDate: '2027-03-01', endTime: '09:00' })).field, 'endTime');
  assert.equal(rules.validateEvent(form({ startDate: '' })).field, 'startDate');
  assert.equal(rules.validateEvent(form({ startDate: '2027-02-30' })).field, 'startDate');
  assert.equal(rules.validateEvent(form({ startTime: '25:00' })).field, 'startTime');
  assert.equal(rules.validateEvent(form({ description: '  ' })).field, 'description', 'English is required');
  assert.equal(rules.validateEvent(form({ descriptionZh: '' })).field, 'descriptionZh', 'and Chinese too');
  assert.equal(rules.validateEvent(form({ descriptionZh: 'x'.repeat(8001) })).field, 'descriptionZh');
  assert.equal(rules.validateEvent(form({ priceType: 'paid', priceMin: '5', currency: 'ZZZ' })).field, 'currency');
  assert.equal(rules.validateEvent(form({ externalUrl: 'http://example.com/a' })).field, 'externalUrl');
  assert.equal(rules.validateEvent(form({ onlineUrl: 'javascript:alert(1)' })).field, 'onlineUrl');
  assert.equal(rules.validateEvent(form({ externalUrl: 'https://user:pw@example.com' })).field, 'externalUrl');
  assert.equal(rules.validateEvent(form({ priceType: 'paid' })).field, 'priceMin');
  assert.equal(rules.validateEvent(form({ priceType: 'paid', priceMin: '20', priceMax: '10' })).field, 'priceMax');
  assert.equal(rules.validateEvent(form({ capacity: '0' })).field, 'capacity');
  assert.equal(rules.validateEvent(form({ title: 'x'.repeat(121) })).field, 'title');
});

test('the start date is required even when the dates are kept off the public page', () => {
  assert.equal(rules.validateEvent(form({ startDate: '', endDate: '', datesHidden: true })).field, 'startDate');
  const r = rules.validateEvent(form({ datesHidden: true }));
  assert.equal(r.ok, true);
  assert.equal(r.fields.dates_hidden, true);
});

test('a time left blank is to be confirmed, and the day still counts until it ends', () => {
  // A start with no time and no end: the whole of that day, in the event's zone.
  const day = rules.validateEvent(form({ startTime: '', endDate: '', endTime: '' }));
  assert.equal(day.ok, true);
  assert.equal(day.fields.starts_at, '2027-02-28T16:00:00.000Z');
  assert.equal(day.fields.start_time_tbc, true);
  assert.equal(day.fields.ends_at, '2027-03-01T15:59:00.000Z');
  assert.equal(day.fields.end_time_tbc, true);

  // A time on the start only: no end.
  const timed = rules.validateEvent(form({ endDate: '', endTime: '' }));
  assert.equal(timed.fields.start_time_tbc, false);
  assert.equal(timed.fields.ends_at, null);

  // An end time with no end date ends on the start date.
  const sameDay = rules.validateEvent(form({ endDate: '', endTime: '17:00' }));
  assert.equal(sameDay.fields.ends_at, '2027-03-01T09:00:00.000Z');

  // A later end date with its time to be confirmed lasts to that day's end.
  const conWeekend = rules.validateEvent(form({ startTime: '', endTime: '' }));
  assert.equal(conWeekend.fields.ends_at, '2027-03-02T15:59:00.000Z');
  assert.equal(conWeekend.fields.end_time_tbc, true);
});

test('locations are checked, blank ones dropped, and the main one copied to the venue columns', () => {
  const r = rules.validateEvent(form({
    locations: [
      { label: 'meeting', venueName: 'Dhoby Ghaut MRT, Exit B', city: 'Singapore', country: 'sg' },
      { label: 'custom', customLabel: '', venueName: 'After-party bar' },
    ],
  }));
  assert.equal(r.ok, false, 'a custom label with a place needs its label');
  assert.equal(r.field, 'customLabel');
  assert.equal(r.location, 1);

  const good = rules.validateEvent(form({
    locations: [
      { label: 'meeting', venueName: 'Dhoby Ghaut MRT, Exit B', city: 'Singapore', country: 'sg', customLabel: 'ignored' },
      { label: 'event', venueName: 'ION Orchard', venueAddress: '2 Orchard Turn', city: 'Singapore', country: 'SG', mapsUrl: 'https://maps.app.goo.gl/abc' },
      { label: 'custom', customLabel: '', venueName: '', venueAddress: '', city: '', country: '', mapsUrl: '' },
    ],
  }));
  assert.equal(good.ok, true);
  assert.equal(good.fields.locations.length, 2, 'the blank one is dropped');
  assert.equal(good.fields.locations[0].country, 'SG');
  assert.equal(good.fields.locations[0].custom_label, null);
  assert.equal(good.fields.venue_name, 'ION Orchard', 'the event location, not the first');
  assert.equal(good.fields.venue_address, '2 Orchard Turn');

  assert.equal(rules.validateEvent(form({ locations: [{ label: 'party', venueName: 'X' }] })).field, 'locationLabel');
  assert.equal(rules.validateEvent(form({ locations: [{ label: 'event', mapsUrl: 'javascript:alert(1)' }] })).field, 'mapsUrl');
  assert.equal(rules.validateEvent(form({ locations: 'Hall' })).field, 'locations');
  assert.equal(rules.validateEvent(form({ locations: Array.from({ length: 11 }, () => ({ label: 'event', venueName: 'X' })) })).field, 'locations');
  const none = rules.validateEvent(form({ locations: [] }));
  assert.equal(none.fields.venue_name, null);
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
  assert.equal(stranger.where.locations[0].address, null);
  assert.equal(stranger.where.locations[0].venueName, 'Hall');
  assert.equal(stranger.where.onlineUrl, null);
  assert.equal(stranger.where.addressForAttendees, true);
  assert.equal(json(stranger).includes('Secret Road'), false);
  assert.equal(json(stranger).includes('meet.example.com'), false);

  const going = ser.publicEventDetail(r, { signedIn: true, going: true }, now);
  assert.equal(going.where.locations[0].address, '1 Secret Road');
  assert.equal(going.where.onlineUrl, 'https://meet.example.com/x');

  const editor = ser.publicEventDetail(r, { signedIn: true, canManage: true }, now);
  assert.equal(editor.where.locations[0].address, '1 Secret Road');

  // A map link gives the place away too, so it is kept with the address.
  const mapped = row({
    address_attendees_only: true,
    locations: [{ label: 'event', venue_name: 'Hall', venue_address: null, maps_url: 'https://maps.app.goo.gl/hidden' }],
  });
  const outsider = ser.publicEventDetail(mapped, { signedIn: true, going: false }, now);
  assert.equal(outsider.where.locations[0].mapsUrl, null);
  assert.equal(outsider.where.addressForAttendees, true);
  assert.equal(json(outsider).includes('goo.gl/hidden'), false);
  assert.equal(ser.publicEventDetail(mapped, { going: true }, now).where.locations[0].mapsUrl, 'https://maps.app.goo.gl/hidden');
});

test('RSVP state and spaces come from the count', () => {
  assert.equal(ser.publicEventCard(row(), now).rsvp, 'open');
  // Spaces left are on the event page only, not on cards (help desk #18).
  assert.equal(ser.publicEventDetail(row(), {}, now).left, 7);
  assert.equal(ser.publicEventCard(row({ gftvevents_attendees: [{ count: 10 }] }), now).rsvp, 'full');
  assert.equal(ser.publicEventCard(row({ status: 'cancelled' }), now).rsvp, 'cancelled');
  assert.equal(ser.publicEventCard(row({ rsvp_open: false }), now).rsvp, 'closed');
  assert.equal(ser.publicEventCard(row({ starts_at: '2026-10-01T00:00:00Z', ends_at: null }), now).rsvp, 'over');
});

test('an attendee is a name, a username and staff or not, never an email or id', () => {
  const staff = ser.attendeeView({ user_id: 'u1', created_at: 'x', account: { kind: 'staff', id: 'u1', staff: { id: 'u1', username: 'fox', display_name: 'Fox', email: 'fox@example.com' } } });
  assert.deepEqual(Object.keys(staff).sort(), ['country', 'displayName', 'meals', 'pastVolunteer', 'rsvpAt', 'rsvpNumber', 'staff', 'username', 'volunteer', 'volunteered']);
  assert.equal(staff.staff, true);
  const member = ser.attendeeView({ user_id: 'p1', rsvp_number: 7, created_at: 'x', account: { kind: 'public', id: 'p1', username: 'otter', display_name: 'Otter', email: 'otter@example.com' } });
  assert.deepEqual(member, { rsvpNumber: 7, username: 'otter', displayName: 'Otter', staff: false, meals: [], country: null, volunteer: false, volunteered: false, pastVolunteer: false, rsvpAt: 'x' });
  assert.equal(JSON.stringify(member).includes('example.com'), false);
  // An attendee's country goes to the editors of a cross-border event only.
  const traveller = { user_id: 'p2', created_at: 'x', account: { kind: 'public', username: 'lynx', display_name: 'Lynx', country: 'MY' } };
  assert.equal(ser.attendeeView(traveller, { cross_border: true }).country, 'MY');
  assert.equal(ser.attendeeView(traveller, { cross_border: false }).country, null);
});

test('meals offered are checked, put in order, and blank named ones dropped', () => {
  const meals = (list) => rules.validateEvent(form({ meals: list }));
  const ok = meals([{ id: 'dinner', limit: '40' }, { id: 'm-tea123', label: '  High tea ', limit: ' ' }, { id: 'breakfast', label: 'ignored' }, { id: 'm-blank1', label: '   ' }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.fields.meal_options, [
    { id: 'breakfast', label: null, limit: null, locations: [] },
    { id: 'dinner', label: null, limit: 40, locations: [] },
    { id: 'm-tea123', label: 'High tea', limit: null, locations: [] },
  ]);
  assert.equal(meals([{ id: 'lunch', limit: '0' }]).field, 'mealLimit');
  assert.equal(meals([{ id: 'lunch', limit: '2.5' }]).field, 'mealLimit');
  assert.equal(meals([{ id: 'lunch', limit: 'ten' }]).field, 'mealLimit');
  assert.deepEqual(meals([]).fields.meal_options, []);
  assert.equal('meal_options' in rules.validateEvent(form()).fields, false, 'no meals field keeps the stored ones');
  assert.equal(meals([{ id: 'supper' }]).field, 'meals');
  assert.equal(meals([{ id: 'lunch' }, { id: 'lunch' }]).field, 'meals');
  assert.equal(meals([{ id: 'm-tea123', label: 'x'.repeat(41) }]).field, 'mealLabel');
  assert.equal(meals('lunch').field, 'meals');
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `m-meal${i}`, label: `Meal ${i}` }));
  assert.equal(meals(six).field, 'meals', 'at most five named meals');
});

test('a meal choice must be meals the event offers, and leaves out ones no longer offered', () => {
  const event = row({
    meal_options: [{ id: 'lunch', label: null, limit: 10 }, { id: 'dinner', label: null }, { id: 'm-tea123', label: 'High tea' }],
    meal_taken: { lunch: 4, dinner: 2 },
  });
  assert.deepEqual(rules.chooseMeals(event, undefined), { ok: true, meals: [] });
  assert.deepEqual(rules.chooseMeals(event, ['m-tea123', 'lunch', 'lunch']), { ok: true, meals: ['lunch', 'm-tea123'] });
  assert.equal(rules.chooseMeals(event, ['breakfast']).ok, false);
  assert.equal(rules.chooseMeals(event, 'lunch').ok, false);
  assert.equal(rules.chooseMeals(row(), ['lunch']).ok, false, 'an event offering no meals takes none');

  const page = ser.publicEventDetail(event, { signedIn: true, going: true, meals: ['dinner', 'breakfast'] }, now);
  assert.deepEqual(page.meals, [
    { id: 'lunch', label: null, limit: 10, left: 6, locations: [] },
    { id: 'dinner', label: null, limit: null, left: null, locations: [] },
    { id: 'm-tea123', label: 'High tea', limit: null, left: null, locations: [] },
  ]);
  assert.deepEqual(page.viewer.meals, ['dinner'], 'breakfast is no longer offered');
  assert.deepEqual(ser.publicEventDetail(event, { signedIn: true, going: false, meals: ['lunch'] }, now).viewer.meals, []);
  const attendee = ser.attendeeView({ created_at: 'x', meals: ['breakfast'], account: { kind: 'public', username: 'otter' } }, event);
  assert.deepEqual(attendee.meals, [], 'left with none: the whole event');
  assert.deepEqual(ser.managedEvent(event).meals, [
    { id: 'lunch', label: '', limit: '10', locations: [] },
    { id: 'dinner', label: '', limit: '', locations: [] },
    { id: 'm-tea123', label: 'High tea', limit: '', locations: [] },
  ]);
});

test('a meal can be held somewhere else, with its own places checked like the event\'s', () => {
  const meals = (list) => rules.validateEvent(form({ meals: list }));
  const ok = meals([
    {
      id: 'dinner',
      locations: [
        { label: 'meal', venueName: ' Lau Pa Sat ', venueAddress: '18 Raffles Quay', city: 'Singapore', country: 'sg', mapsUrl: 'https://maps.app.goo.gl/abc' },
        { label: 'meeting', customLabel: 'dropped', venueName: 'Exit A, Raffles Place MRT' },
        { label: 'custom', venueName: '', city: '' },
      ],
    },
    { id: 'm-tea123', label: 'High tea', locations: [{ label: 'custom', customLabel: 'Tea room', venueName: 'Level 2' }] },
    { id: 'lunch', locations: [] },
  ]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.fields.meal_options, [
    { id: 'lunch', label: null, limit: null, locations: [] },
    {
      id: 'dinner',
      label: null,
      limit: null,
      locations: [
        { label: 'meal', custom_label: null, venue_name: 'Lau Pa Sat', venue_address: '18 Raffles Quay', city: 'Singapore', country: 'SG', maps_url: 'https://maps.app.goo.gl/abc' },
        { label: 'meeting', custom_label: null, venue_name: 'Exit A, Raffles Place MRT', venue_address: null, city: null, country: null, maps_url: null },
      ],
    },
    {
      id: 'm-tea123',
      label: 'High tea',
      limit: null,
      locations: [{ label: 'custom', custom_label: 'Tea room', venue_name: 'Level 2', venue_address: null, city: null, country: null, maps_url: null }],
    },
  ]);
  assert.deepEqual(ok.fields.locations, rules.validateEvent(form()).fields.locations, "the event's own places are untouched");

  const bad = meals([{ id: 'lunch' }, { id: 'dinner', locations: [{ label: 'meal', venueName: 'A' }, { label: 'meal', mapsUrl: 'http://maps.example' }] }]);
  assert.deepEqual(bad, { ok: false, error: 'invalid_field', field: 'mapsUrl', location: 1, meal: 'dinner' });
  assert.deepEqual(meals([{ id: 'lunch', locations: [{ label: 'event', venueName: 'A' }] }]), { ok: false, error: 'invalid_field', field: 'locationLabel', location: 0, meal: 'lunch' });
  assert.equal(meals([{ id: 'lunch', locations: [{ label: 'custom', venueName: 'A' }] }]).field, 'customLabel');
  const four = Array.from({ length: 4 }, () => ({ label: 'meal', venueName: 'A' }));
  assert.deepEqual(meals([{ id: 'lunch', locations: four }]), { ok: false, error: 'invalid_field', field: 'mealLocations', meal: 'lunch' });
  assert.equal(meals([{ id: 'lunch', locations: 'Lau Pa Sat' }]).field, 'mealLocations');

  // On the event page, an attendees-only address keeps a meal's street
  // address and map link from people not going, like the event's own.
  const stored = row({
    address_attendees_only: true,
    meal_options: ok.fields.meal_options,
    meal_taken: {},
  });
  const outsider = ser.publicEventDetail(stored, { signedIn: true, going: false }, now);
  const dinner = outsider.meals.find((meal) => meal.id === 'dinner');
  assert.deepEqual(dinner.locations[0], { label: 'meal', customLabel: null, venueName: 'Lau Pa Sat', city: 'Singapore', country: 'SG', address: null, mapsUrl: null });
  assert.equal(outsider.where.addressForAttendees, true, 'a meal address alone is enough for the note');
  const insider = ser.publicEventDetail(stored, { signedIn: true, going: true, meals: [] }, now);
  assert.equal(insider.meals.find((meal) => meal.id === 'dinner').locations[0].address, '18 Raffles Quay');
  assert.equal(insider.meals.find((meal) => meal.id === 'dinner').locations[0].mapsUrl, 'https://maps.app.goo.gl/abc');
  assert.deepEqual(ser.managedEvent(stored).meals[1].locations[0], {
    label: 'meal', customLabel: '', venueName: 'Lau Pa Sat', venueAddress: '18 Raffles Quay', city: 'Singapore', country: 'SG', mapsUrl: 'https://maps.app.goo.gl/abc',
  });
  // A stored place with a label meals cannot have is skipped.
  assert.deepEqual(rules.storedMeals({ meal_options: [{ id: 'lunch', locations: [{ label: 'event', venue_name: 'X' }, null] }] })[0].locations, []);
});

test('ticket tiers are checked, set the price range, and are only on for a paid event', () => {
  const tiers = [
    { name: ' Day pass ', price: '45', benefits: 'Entry on one day\n\n  Lanyard ', includesPrevious: true },
    { name: '', price: '', benefits: '  ' },
    { name: 'Weekend', price: '80', benefits: 'All three days', includesPrevious: true, previousDisplay: 'full' },
    { name: 'Sponsor', price: '120.5', benefits: 'Sponsor badge', includesPrevious: true },
  ];
  const paid = rules.validateEvent(form({ priceType: 'paid', tiersEnabled: true, ticketTiers: tiers, priceMin: 'ignored' }));
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(paid.fields.tiers_enabled, true);
  assert.equal(paid.fields.price_min, 45);
  assert.equal(paid.fields.price_max, 120.5);
  assert.deepEqual(paid.fields.ticket_tiers.map((tier) => [tier.name, tier.price, tier.benefits, tier.includes_previous, tier.previous_display]), [
    ['Day pass', 45, ['Entry on one day', 'Lanyard'], false, 'reference'],
    ['Weekend', 80, ['All three days'], true, 'full'],
    ['Sponsor', 120.5, ['Sponsor badge'], true, 'reference'],
  ]);

  // Kept but off for a free event; the From field is not needed while on.
  const free = rules.validateEvent(form({ priceType: 'free', tiersEnabled: true, ticketTiers: tiers }));
  assert.equal(free.fields.tiers_enabled, false);
  assert.equal(free.fields.ticket_tiers.length, 3);
  assert.equal('ticket_tiers' in rules.validateEvent(form()).fields, false, 'no tiers field keeps the stored ones');

  const bad = (list) => rules.validateEvent(form({ priceType: 'paid', tiersEnabled: true, ticketTiers: list }));
  assert.deepEqual(bad([{ name: 'A', price: '1' }, { name: 'B', price: '' }]), { ok: false, error: 'invalid_field', field: 'tierPrice', tier: 1 });
  assert.equal(bad([{ price: '5' }]).field, 'tierName');
  assert.equal(bad([{ name: 'A', price: '-1' }]).field, 'tierPrice');
  assert.equal(bad([{ name: 'A', price: '1', benefits: 'x'.repeat(201) }]).field, 'tierBenefits');
  const none = bad([]);
  assert.equal(none.ok, true);
  assert.equal(none.fields.price_min, null, 'on with no tiers yet: price to be announced');
  assert.equal(bad(Array.from({ length: 11 }, () => ({ name: 'A', price: '1' }))).field, 'ticketTiers');
});

test('the event page shows tiers with earlier benefits in full or by name, and hides prices when the price is', () => {
  const event = row({
    tiers_enabled: true,
    ticket_tiers: [
      { name: 'Day', price: 45, benefits: ['Entry'], includes_previous: false, previous_display: 'reference' },
      { name: 'Weekend', price: 80, benefits: ['Three days'], includes_previous: true, previous_display: 'full' },
      { name: 'Sponsor', price: 120, benefits: ['Badge'], includes_previous: true, previous_display: 'full' },
      { name: 'Super', price: 300, benefits: ['Dinner'], includes_previous: true, previous_display: 'reference' },
      { name: 'Solo', price: 10, benefits: ['Sticker'], includes_previous: false, previous_display: 'full' },
    ],
  });
  assert.deepEqual(ser.publicEventDetail(event, {}, now).tiers, [
    { name: 'Day', price: 45, benefits: ['Entry'], includedBenefits: [], includesTier: null },
    { name: 'Weekend', price: 80, benefits: ['Three days'], includedBenefits: ['Entry'], includesTier: null },
    { name: 'Sponsor', price: 120, benefits: ['Badge'], includedBenefits: ['Entry', 'Three days'], includesTier: null },
    { name: 'Super', price: 300, benefits: ['Dinner'], includedBenefits: [], includesTier: 'Sponsor' },
    { name: 'Solo', price: 10, benefits: ['Sticker'], includedBenefits: [], includesTier: null },
  ]);
  assert.deepEqual(ser.publicEventDetail(row({ ...event, price_hidden: true }), {}, now).tiers.map((tier) => tier.price), [null, null, null, null, null]);
  assert.deepEqual(ser.publicEventDetail(row({ ...event, tiers_enabled: false }), {}, now).tiers, []);
  assert.deepEqual(ser.publicEventDetail(row({ ...event, price_type: 'free' }), {}, now).tiers, []);
  assert.deepEqual(ser.managedEvent(event).ticketTiers[1], { name: 'Weekend', price: '80', benefits: 'Three days', includesPrevious: true, previousDisplay: 'full' });
});

test('the signed-in view of yourself has no secrets', () => {
  const view = ser.selfView({
    id: 'u1', kind: 'staff', username: 'fox', display_name: 'Fox', email: 'fox@example.com', password_hash: '$2a$', totp_secret: 'ABC',
    is_admin: false, is_editor: true, is_approved: true, avatar_url: 'http://insecure.example/a.png',
  });
  assert.deepEqual(view, { username: 'fox', displayName: 'Fox', avatarUrl: null, kind: 'staff', role: 'editor', canManage: true, country: null });
  const member = ser.selfView({ id: 'p1', kind: 'public', username: 'otter', display_name: 'Otter', is_approved: true, password_hash: '$2a$', country: 'SG' });
  assert.deepEqual(member, { username: 'otter', displayName: 'Otter', avatarUrl: null, kind: 'public', role: 'member', canManage: false, country: 'SG' });
});

test('a public account can never manage events, whatever its row says', () => {
  assert.equal(users.canManage({ kind: 'public', is_approved: true, is_admin: true, is_editor: true }), false);
  assert.equal(users.secondFactorRequired({ kind: 'staff' }), true);
  assert.equal(users.secondFactorRequired({ kind: 'public' }), false);
});

test('the editor view round-trips the form fields, including staff notes', () => {
  const view = ser.managedEvent(row(), now);
  assert.equal(view.staffNotes, 'internal only');
  assert.equal(view.startDate, '2026-11-14');
  assert.equal(view.startTime, '14:00');
  assert.equal(view.description, 'Long text');
  assert.equal(view.descriptionZh, '长文');
  // An event saved before the locations list has its place as its one location.
  assert.deepEqual(view.locations, [{ label: 'event', customLabel: '', venueName: 'Hall', venueAddress: '1 Secret Road', city: 'Singapore', country: 'Singapore', mapsUrl: '' }]);
  const again = rules.validateEvent(view);
  assert.equal(again.ok, true);
  assert.equal(again.fields.starts_at, row().starts_at);
  assert.equal(again.fields.ends_at, row().ends_at);
  assert.equal(again.fields.venue_name, 'Hall');

  // A day with its time to be confirmed comes back with the times blank,
  // and the end the API filled in blank too.
  const day = rules.validateEvent({ ...view, startTime: '', endDate: '', endTime: '' }).fields;
  const dayView = ser.managedEvent(row(day), now);
  assert.deepEqual([dayView.startDate, dayView.startTime, dayView.endDate, dayView.endTime], ['2026-11-14', '', '', '']);
  assert.equal(rules.validateEvent(dayView).fields.ends_at, day.ends_at);
});

test('when goes out with whether each time is still to be confirmed', () => {
  const card = ser.publicEventCard(row({ start_time_tbc: true, end_time_tbc: true }), now);
  assert.equal(card.when.startTimeTbc, true);
  assert.equal(card.when.endTimeTbc, true);
  assert.equal(ser.publicEventCard(row(), now).when.startTimeTbc, false);
});


test('no route sends a database result straight out', () => {
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
  const files = (function walk(dir) {
    return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  })(api).filter((f) => f.endsWith('.js') && !f.includes('_lib'));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // ok(response, data) / ok(response, row) / ok(response, { ...data }) would pass rows through.
    assert.doesNotMatch(src, /\bok\(res,\s*(data|row|rows|fresh|event)\s*\)/, file);
    assert.doesNotMatch(src, /\bok\(res,\s*\{\s*\.\.\.(data|row)\b/, file);
    assert.doesNotMatch(src, /response\.json\(/, file);
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

const signup = (over = {}) => ({ username: 'Snow_Fox', displayName: '  Snow   Fox ', email: ' Snow@Example.com ', password: 'a long enough secret', country: 'sg', agree: true, ...over });

test('sign-up input is cleaned and checked', () => {
  const r = acct.validateSignup(signup());
  assert.deepEqual(r, { ok: true, fields: { username: 'snow_fox', displayName: 'Snow Fox', email: 'snow@example.com', country: 'SG' } });
  assert.equal(acct.validateSignup(signup({ country: '' })).error, 'country_required');
  assert.equal(acct.validateSignup(signup({ country: 'XX' })).error, 'country_required', 'not a country');
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

test('cover addresses are this site\'s, built from the stored path only', () => {
  const path = '11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuv.webp';
  assert.equal(covers.coverUrl({ slug: 'meet', cover_image_path: path }), '/api/events/cover?slug=meet&v=abcdefghijklmnopqrstuv');
  assert.equal(covers.coverUrl({ slug: 'meet', cover_image_path: '../../etc/passwd' }), null);
  assert.equal(covers.coverUrl({ slug: 'meet', cover_image_path: null }), null);
  const card = ser.publicEventCard(row({ cover_image_path: path, cover_image_url: 'https://old.example/a.png' }), now);
  assert.equal(card.coverImageUrl, covers.coverUrl({ slug: card.slug, cover_image_path: path }));
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

  // The first save after migrations/004 writes the place into the list in
  // full; that is the same place, so nobody is told.
  const saved = rules.validateEvent(ser.managedEvent(live, now)).fields;
  assert.equal(notify.changeKind(live, { ...live, ...saved }), null, 'columns only, then the list');
  const migrated = { ...live, locations: [{ label: 'event', venue_name: 'Hall', venue_address: '1 Secret Road', city: 'Singapore', country: 'Singapore' }] };
  assert.equal(notify.changeKind(migrated, { ...live, ...saved }), null, 'a shorter stored shape');
  assert.equal(notify.changeKind(live, { ...live, ...saved, start_time_tbc: true }), 'updated', 'the time no longer set');
  const meeting = { label: 'meeting', venue_name: 'Exit B', custom_label: null, venue_address: null, city: null, country: null, maps_url: null };
  assert.equal(notify.changeKind(live, { ...live, ...saved, locations: [...saved.locations, meeting] }), 'updated', 'a meeting point added');

  // A meal moving somewhere else (or back) is a change of place; a meal
  // added, dropped or given a limit is not. A notice_base kept before meal
  // places has no meal_options, and tells nobody about them.
  const atEvent = { ...live, meal_options: [{ id: 'dinner', label: null, limit: null, locations: [] }] };
  const restaurant = { label: 'meal', custom_label: null, venue_name: 'Lau Pa Sat', venue_address: null, city: null, country: null, maps_url: null };
  const away = { ...live, meal_options: [{ id: 'dinner', label: null, limit: null, locations: [restaurant] }] };
  assert.equal(notify.changeKind(atEvent, away), 'updated', 'dinner moved to a restaurant');
  assert.equal(notify.changeKind(away, atEvent), 'updated', 'dinner back at the event');
  assert.equal(notify.changeKind(away, { ...away, meal_options: [{ ...away.meal_options[0], limit: 20 }] }), null, 'a limit only');
  assert.equal(notify.changeKind(atEvent, { ...live, meal_options: [...atEvent.meal_options, { id: 'm-tea123', label: 'Tea', locations: [restaurant] }] }), null, 'a meal added');
  const { meal_options: _dropped, ...oldBase } = atEvent;
  assert.equal(notify.changeKind(oldBase, away), null, 'a base from before meal places');
});

test('a notice carries public fields only', () => {
  const r = row({ is_online: true, online_url: 'https://meet.example.com/secret', venue_address: '1 Secret Road', address_attendees_only: true });
  for (const kind of ['updated', 'cancelled', 'new']) {
    const n = notify.noticeFor(kind, r);
    const text = JSON.stringify(n);
    assert.equal(text.includes('meet.example.com'), false, kind);
    assert.equal(text.includes('Secret Road'), false, kind);
    assert.equal(text.includes('internal only'), false, kind);
    assert.equal(n.url, 'https://events.globalfurry.tv/e/sg-furmeet');
  }
  assert.ok(notify.noticeFor('new', row({ dates_hidden: true })).lines.includes('Dates to be announced'));
});

test('a Telegram event notice puts the date, time and place on lines of their own, with the cover under the link', () => {
  const cover = '11111111-1111-4111-8111-111111111111/AbCdEfGhIjKlMnOpQrStUv.webp';
  const r = row({ starts_at: '2032-08-06T10:00:00.000Z', timezone: 'Asia/Singapore', venue_name: 'Hall', city: 'Singapore', is_online: false, cover_image_path: cover });
  const { markdown, fallback } = msgs.eventNoticeMessage(notify.noticeFor('new', r));
  const image = 'https://events.globalfurry.tv/api/events/embed-image?slug=sg-furmeet&v=AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(
    markdown,
    '## New event\n\n**SG Furmeet**\n\n**Date:** Fri, 6 Aug 2032\n\n**Time:** 6:00 pm SGT\n\n**Location:** Hall, Singapore\n\n' +
      `https://events.globalfurry.tv/e/sg-furmeet\n\n![](${image})`
  );
  assert.ok(fallback.includes('Date: Fri, 6 Aug 2032\nTime: 6:00 pm SGT\nLocation: Hall, Singapore'));

  // No cover, no picture; a time to be confirmed says so; dates to be
  // announced have no time line.
  const plain = msgs.eventNoticeMessage(notify.noticeFor('cancelled', row({ start_time_tbc: true, cover_image_path: null })));
  assert.equal(plain.markdown.includes('!['), false);
  assert.ok(plain.markdown.includes('This event will not go ahead.\n\n**Date:**'));
  assert.ok(plain.markdown.includes('**Time:** To be confirmed'));
  const tba = notify.noticeFor('new', row({ dates_hidden: true }));
  assert.deepEqual(tba.details.map(([label]) => label), ['Date', 'Location']);
});

test('a reminder goes at the closest time picked that has come, once, and not to someone who has just said they are going', () => {
  const hour = 3_600_000;
  const start = Date.parse('2032-08-06T10:00:00Z');
  const due = (over) => notify.dueReminder({ startsAt: '2032-08-06T10:00:00Z', chosen: [1, 24, 168], sent: [], rsvpAt: '2032-07-01T00:00:00Z', ...over });
  assert.equal(due({ now: start - 8 * 24 * hour }), null, 'more than a week away');
  assert.deepEqual(due({ now: start - 7 * 24 * hour + 60_000 }), { hours: 168, send: true, mark: [168] });
  assert.equal(due({ now: start - 3 * 24 * hour, sent: [168] }), null, 'the week one went');
  assert.deepEqual(due({ now: start - 24 * hour - 4 * 60_000, sent: [168] }), { hours: 24, send: true, mark: [168, 24] }, 'up to five minutes early');
  assert.equal(due({ now: start - 24 * hour - 6 * 60_000, sent: [168] }), null, 'not six minutes early');
  // A cron down all day: only the hour before goes, the day before marked.
  assert.deepEqual(due({ now: start - 50 * 60_000, sent: [168] }), { hours: 1, send: true, mark: [168, 24, 1] });
  assert.equal(due({ now: start + 60_000 }), null, 'started');
  // Said they were going after the time came: marked, not sent.
  assert.deepEqual(due({ now: start - 30 * 60_000, chosen: [1], rsvpAt: new Date(start - 40 * 60_000).toISOString() }), { hours: 1, send: false, mark: [1] });
  assert.equal(due({ now: start - 30 * 60_000, chosen: [] }), null, 'no times picked');
  assert.equal(due({ now: start - 30 * 60_000, chosen: [5, 'x'] }), null, 'only the allowed times');
  // A start time to be confirmed: the hour reminders mean nothing.
  assert.equal(due({ now: start - 30 * 60_000, chosen: [1, 2, 3], timeTbc: true }), null);
  assert.equal(due({ now: start - 23 * hour, chosen: [1, 24], timeTbc: true }).hours, 24);
});

test('a reminder for someone coming just for dinner names it and where it is, and keeps the push to the public when and where', () => {
  const event = row({
    starts_at: '2032-08-06T10:00:00.000Z',
    venue_address: '1 Secret Road',
    address_attendees_only: true,
    locations: [{ label: 'event', venue_name: 'Hall', venue_address: '1 Secret Road', city: 'Singapore', country: 'SG' }],
    meal_options: [
      { id: 'lunch', label: null, locations: [{ label: 'meal', venue_name: 'Food Court' }] },
      { id: 'dinner', label: null, locations: [{ label: 'meal', venue_name: 'Lau Pa Sat' }, { label: 'meeting', venue_name: 'Exit H' }] },
      { id: 'm-tea123', label: 'High tea', locations: [{ label: 'custom', custom_label: 'Tea room', venue_name: 'Level 2' }] },
    ],
  });
  const reminder = notify.reminderNotice(event, ['dinner'], Date.parse('2032-08-05T10:00:00.000Z'));
  assert.equal(reminder.heading, 'Starting in 1 day');
  assert.deepEqual(reminder.details.find(([label]) => label === 'Coming for'), ['Coming for', 'Dinner only']);
  assert.equal(reminder.mealsHeading, 'Your meals');
  assert.deepEqual(reminder.mealPlaces.map((place) => place.heading), ['Dinner', 'Dinner · Meeting location']);
  assert.equal(JSON.stringify(reminder.lines).includes('Secret Road'), false);
  assert.ok(reminder.rich.markdown.includes('| Address | 1 Secret Road |'));
  assert.ok(reminder.rich.fallback.includes('YOUR MEALS\n\nDinner\nVenue: Lau Pa Sat'));
  assert.ok(reminder.rich.fallback.includes('Address: 1 Secret Road'));

  const whole = notify.reminderNotice(event, [], Date.parse('2032-08-06T09:00:00.000Z'));
  assert.equal(whole.heading, 'Starting in 1 hour');
  assert.equal(whole.mealsHeading, 'Meals held elsewhere');
  assert.deepEqual(whole.mealPlaces.map((place) => place.heading), ['Lunch', 'Dinner', 'Dinner · Meeting location', 'High tea · Tea room']);
  // Data is escaped for Rich Markdown.
  const tricky = notify.reminderNotice(row({ title: 'Paws | *Claws*', starts_at: '2032-08-06T10:00:00.000Z' }), [], Date.parse('2032-08-06T07:00:00.000Z'));
  assert.ok(tricky.rich.markdown.includes('**Paws \\| \\*Claws\\***'));
  assert.equal(tricky.heading, 'Starting in 3 hours');
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
