// Events: what an editor may save, when an event is public, and converting
// wall-clock times in an event's own time zone to and from UTC.
//
// Pure functions, no database, so tests/unit.test.js can run them directly.

import { cleanDescription } from './rich-text.js';
import { readContactFields, readContactRule } from '../../js/contact-fields.js';
import { readRegistrationFields, registrationAsksFursuiting } from '../../js/registration-fields.js';

export const KINDS = ['furmeet', 'convention', 'other'];
export const STATUSES = ['draft', 'published', 'cancelled'];
export const PRICE_TYPES = ['free', 'paid', 'tba'];
export const DEFAULT_TIMEZONE = 'Asia/Singapore';
// What a location is: where the event is, where people meet first, or a
// label the editor types.
export const LOCATION_LABELS = ['event', 'meeting', 'custom'];
export const MAX_LOCATIONS = 10;
// The meals someone can come to on their own, instead of the whole event
// (migrations/007): these three, ticked on the form, plus up to
// MAX_CUSTOM_MEALS the editor names.
export const BUILT_IN_MEALS = ['breakfast', 'lunch', 'dinner'];
export const MAX_CUSTOM_MEALS = 5;
// A meal held somewhere other than the event itself has its own places, at
// most MAX_MEAL_LOCATIONS: where the meal is, where people meet first for
// it, or a label the editor types. None means the meal is at the event's
// own place.
export const MEAL_LOCATION_LABELS = ['meal', 'meeting', 'custom'];
export const MAX_MEAL_LOCATIONS = 3;
// Ticket tiers on a paid event (migrations/008): at most MAX_TIERS, each with
// at most MAX_TIER_BENEFITS benefits. A tier can include everything in any
// other tier (a weekend pass the attendee pass, a day pass just the
// attendee pass too), and shows those benefits again in full, or names the
// tier ("reference"). One person can buy several tiers at once, each once,
// or up to MAX_PER_PERSON of a tier the editor lets them buy more than once
// of (migrations/022).
export const MAX_TIERS = 10;
export const MAX_TIER_BENEFITS = 20;
export const MAX_PER_PERSON = 20;
export const PREVIOUS_DISPLAYS = ['full', 'reference'];
// Volunteers (migrations/012): only a convention takes them, and a later
// convention can give the people who volunteered at an earlier one a
// percentage or a fixed amount off.
export const VOLUNTEER_KIND = 'convention';
export const DISCOUNT_TYPES = ['percent', 'amount'];
// What the event page's link button says (migrations/015): one of these, or
// the editor's own words ('custom').
export const LINK_LABELS = ['tickets_website', 'tickets', 'website', 'group', 'register', 'custom'];
// Timetables (migrations/014): how the event page shows one (a timeline, or
// a grid with a column per room), at most MAX_ROOMS rooms and at most
// MAX_TIMETABLE_ITEMS items. An item with no end is drawn in the grid, and
// counts as on now, for TIMETABLE_DEFAULT_MINUTES.
export const TIMETABLE_VIEWS = ['timeline', 'grid'];
export const MAX_ROOMS = 20;
export const MAX_TIMETABLE_ITEMS = 300;
export const TIMETABLE_DEFAULT_MINUTES = 30;

export const LIMITS = Object.freeze({
  title: 120,
  summary: 280,
  venueName: 160,
  venueAddress: 300,
  city: 80,
  country: 80,
  organiserName: 120,
  priceNote: 200,
  staffNotes: 4000,
  url: 500,
  label: 60,
  mealLabel: 40,
  tierName: 60,
  tierBenefit: 200,
  roomName: 60,
  roomTag: 20,
  itemTitle: 120,
  itemNote: 300,
  linkLabel: 40,
  paymentInstructions: 1000,
  paymentReference: 120,
  lepakLabel: 40,
});

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A wall-clock time as the edit form sends it: "2026-11-14T14:00".
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
// A date and a time of day, as the form's date and time inputs send them.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Where a date with no time is put: the start of its day, or the end of it,
// so an event with a time still to be confirmed is not over until its last
// day ends.
const DAY_START = '00:00';
const DAY_END = '23:59';
// A two-letter ISO 3166 country code, as the form's country list sends it.
const COUNTRY_CODE = /^[A-Za-z]{2}$/;
// The id of a meal the editor named: "m-" and a few letters and digits, made
// by the edit form when the meal is added and kept from then on, so the
// people coming for it stay with it when it is renamed.
const CUSTOM_MEAL_ID = /^m-[a-z0-9]{4,16}$/;
// The id of a timetable room: "r-" and a few letters and digits, made by the
// edit form when the room is added and kept from then on, so the items in it
// stay with it when it is renamed.
const ROOM_ID = /^r-[a-z0-9]{4,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every currency code this runtime knows (ISO 4217), for checking the form's
// currency. Empty if the runtime cannot list them, and then any three
// capital letters pass.
function knownCurrencies() {
  try {
    return new Set(Intl.supportedValuesOf('currency'));
  } catch {
    return new Set();
  }
}
const CURRENCIES = knownCurrencies();

// The value as a string, with null and undefined read as ''.
function stringOrEmpty(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Visibility. The one rule for "can the public see this event": published or
// cancelled, and past its release time. Drafts, and published events whose
// release time has not come, are unreleased: they are never sent to anyone
// but editors, and the public routes answer 404 for them, not 403, so their
// existence is not given away either.
// ---------------------------------------------------------------------------

export function isReleased(row, now = Date.now()) {
  if (!row) {
    return false;
  }
  if (row.status !== 'published' && row.status !== 'cancelled') {
    return false;
  }
  if (row.publish_at && new Date(row.publish_at).getTime() > now) {
    return false;
  }
  return true;
}

// The same rule as a PostgREST filter, applied in the query so unreleased
// rows never leave the database for a public request.
// alsoAll: more PostgREST groups ("or(...)") every row must also match,
// such as a search's (searchGroups). They go in the same or() filter as the
// release time, nested under and(), since a query takes one or().
export function releasedFilter(query, nowIso = new Date().toISOString(), alsoAll = []) {
  // The timestamp is quoted because it contains PostgREST's reserved "." and
  // ":" characters. It is always a Date#toISOString(), never user input.
  const released = `publish_at.is.null,publish_at.lte."${nowIso}"`;
  const statuses = query.in('status', ['published', 'cancelled']);
  if (alsoAll.length === 0) {
    return statuses.or(released);
  }
  return statuses.or(`and(or(${released}),${alsoAll.join(',')})`);
}

// The fields the feed's search looks in, and its limits.
const SEARCH_COLUMNS = ['title', 'summary', 'venue_name', 'city', 'country', 'organiser_name'];
export const MAX_SEARCH_LENGTH = 80;
const MAX_SEARCH_WORDS = 5;

// The words of a search as typed: lowercased, at most MAX_SEARCH_WORDS, with
// anything PostgREST reads as syntax or a wildcard taken out, so a search is
// only ever text. [] for none.
export function searchWords(value) {
  return cleanText(value, MAX_SEARCH_LENGTH)
    .slice(0, MAX_SEARCH_LENGTH)
    .toLowerCase()
    .replace(/["\\(),%_*]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS);
}

// One PostgREST group per word, each matching an event with that word in
// any of SEARCH_COLUMNS, for releasedFilter: every word must be found.
export function searchGroups(words) {
  return words.map((word) => `or(${SEARCH_COLUMNS.map((column) => `${column}.ilike."%${word}%"`).join(',')})`);
}

// Whether the event has finished: its end, or its start when it has no end,
// is in the past. An event with neither is never over.
export function isOver(row, now = Date.now()) {
  let lastTime = row.ends_at;
  if (!lastTime) {
    lastTime = row.starts_at;
  }
  if (!lastTime) {
    return false;
  }
  return new Date(lastTime).getTime() < now;
}

export function datesAnnounced(row) {
  if (row.dates_hidden) {
    return false;
  }
  return Boolean(row.starts_at);
}

// ---------------------------------------------------------------------------
// Time zones. Editors type a wall-clock time ("2026-11-14T14:00") in the
// event's own zone; the database keeps UTC. No library: Intl does it.
// ---------------------------------------------------------------------------

export function isTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Milliseconds the zone is ahead of UTC at `instant` (milliseconds since
// 1970). It reads the zone's wall clock at that instant, then measures how
// far that wall clock is from UTC.
function zoneOffset(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// "2026-11-14T14:00" in timeZone -> ISO string in UTC, or null if malformed.
export function wallToUtc(wallTime, timeZone) {
  const match = WALL_TIME.exec(stringOrEmpty(wallTime));
  if (!match || !isTimeZone(timeZone)) {
    return null;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset, including across a daylight saving change.
  let utcTime = guess - zoneOffset(guess, timeZone);
  utcTime = guess - zoneOffset(utcTime, timeZone);
  const date = new Date(utcTime);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

// ISO string in UTC -> "2026-11-14T14:00" in timeZone, for the edit form.
export function utcToWall(isoString, timeZone) {
  if (!isoString || !isTimeZone(timeZone)) {
    return '';
  }
  const instant = new Date(isoString).getTime();
  if (Number.isNaN(instant)) {
    return '';
  }
  const wallClock = new Date(instant + zoneOffset(instant, timeZone));
  return wallClock.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Validation. The editor form sends camelCase fields; this returns the
// snake_case columns to write, or the first problem as { error, field }.
// Unknown fields are ignored, so nothing the browser invents reaches the
// table. Text is trimmed and length-checked; addresses must be https.
// ---------------------------------------------------------------------------

// Normalised text with line endings unified and control characters (other
// than tab and newline) removed. It keeps one character more than
// maximumLength, so the caller can tell a value that was too long.
function cleanText(value, maximumLength) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maximumLength + 1);
}

// { ok: true, url } with the address (null when blank), or { ok: false }.
// Only https, with a dotted host name and no user name or password in it.
export function httpsUrl(value) {
  const raw = cleanText(value, LIMITS.url);
  if (raw === '') {
    return { ok: true, url: null };
  }
  if (raw.length > LIMITS.url) {
    return { ok: false };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) {
    return { ok: false };
  }
  return { ok: true, url: url.href };
}

// A slug made from a title: accents dropped, lowercase, words joined by
// hyphens, at most 50 characters. A title too short for that gets "event-".
export function slugify(title) {
  const base = stringOrEmpty(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  if (base.length >= 3) {
    return base;
  }
  let ending = base;
  if (!ending) {
    ending = 'new';
  }
  return `event-${ending}`.slice(0, 50);
}

export function isSlug(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length < 3 || value.length > 60) {
    return false;
  }
  return SLUG.test(value);
}

// { ok: true, value } with the amount rounded to cents (null when blank), or
// { ok: false }.
function parseMoney(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null };
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 99_999_999) {
    return { ok: false };
  }
  return { ok: true, value: Math.round(amount * 100) / 100 };
}

// value when it is one of allowed, otherwise null.
function allowedOrNull(allowed, value) {
  if (allowed.includes(value)) {
    return value;
  }
  return null;
}

// Each step below reads some of the form's fields from body and writes their
// columns into fields. It returns the form field's name at the first problem,
// or null when its part is fine.

// Title, slug, kind and status. A blank slug is made from the title.
function readIdentity(body, fields) {
  fields.title = cleanText(body.title, LIMITS.title);
  if (fields.title === '' || fields.title.length > LIMITS.title) {
    return 'title';
  }

  const slug = cleanText(body.slug, 60).toLowerCase();
  if (slug === '') {
    fields.slug = slugify(fields.title);
  } else {
    fields.slug = slug;
  }
  if (!isSlug(fields.slug)) {
    return 'slug';
  }

  fields.kind = allowedOrNull(KINDS, body.kind);
  if (!fields.kind) {
    return 'kind';
  }
  fields.status = allowedOrNull(STATUSES, body.status);
  if (!fields.status) {
    return 'status';
  }
  return null;
}

// The free-text fields: [form field, column, longest allowed]. The place
// fields are per location (readLocations).
const TEXT_FIELDS = [
  ['summary', 'summary', LIMITS.summary],
  ['organiserName', 'organiser_name', LIMITS.organiserName],
  ['priceNote', 'price_note', LIMITS.priceNote],
  ['staffNotes', 'staff_notes', LIMITS.staffNotes],
];

// The text, length-checked, into column: { ok: true } with a blank stored as
// null, or { ok: false } when it is too long.
function putText(target, column, value, maximumLength) {
  const text = cleanText(value, maximumLength);
  if (text.length > maximumLength) {
    return { ok: false };
  }
  if (text === '') {
    target[column] = null;
  } else {
    target[column] = text;
  }
  return { ok: true };
}

// The descriptions every event must have: [form field, column]. One in
// English and one in Chinese (migrations/005); the form switches between
// them.
const REQUIRED_DESCRIPTIONS = [
  ['description', 'description'],
  ['descriptionZh', 'description_zh'],
];

// Each free-text field, length-checked; then both descriptions, rich text
// cleaned to what a description may hold (rich-text.js), which may not be
// blank.
function readTextFields(body, fields) {
  for (const [formField, column, maximumLength] of TEXT_FIELDS) {
    if (!putText(fields, column, body[formField], maximumLength).ok) {
      return formField;
    }
  }
  for (const [formField, column] of REQUIRED_DESCRIPTIONS) {
    const cleaned = cleanDescription(body[formField]);
    if (!cleaned.ok) {
      return formField;
    }
    if (cleaned.html === '') {
      fields[column] = null;
    } else {
      fields[column] = cleaned.html;
    }
  }
  for (const [formField, column] of REQUIRED_DESCRIPTIONS) {
    if (fields[column] === null) {
      return formField;
    }
  }
  return null;
}

// Whether "2027-02-30" is a day on the calendar, not only shaped like one.
function isCalendarDate(value) {
  const match = DATE_ONLY.exec(value);
  if (!match) {
    return false;
  }
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
    return true;
  }
  return false;
}

// One date and optional time from the form, in the event's zone, as
// { ok: true, at, timeTbc } (at in UTC; a blank time is put at
// blankTimeAt and marked as to be confirmed) or { ok: false, field }
// naming the form field that is wrong.
function readDayAndTime(date, time, timeZone, blankTimeAt, names) {
  if (!isCalendarDate(date)) {
    return { ok: false, field: names.date };
  }
  let wallClock = blankTimeAt;
  if (time !== '') {
    if (!TIME_ONLY.test(time)) {
      return { ok: false, field: names.time };
    }
    wallClock = time;
  }
  const at = wallToUtc(`${date}T${wallClock}`, timeZone);
  if (!at) {
    return { ok: false, field: names.date };
  }
  return { ok: true, at, timeTbc: time === '' };
}

// The time zone, then the start and end, and the release time, converted
// from it to UTC.
//
// The start date is required; its time may be blank while it is still to be
// confirmed. The end is optional. An end time with no end date ends on the
// start date, and a start with no time and no end lasts the whole of its
// day. The end cannot come before the start.
function readTimes(body, fields) {
  if (body.timezone === undefined || body.timezone === '') {
    fields.timezone = DEFAULT_TIMEZONE;
  } else {
    fields.timezone = body.timezone;
  }
  if (!isTimeZone(fields.timezone)) {
    return 'timezone';
  }
  fields.dates_hidden = body.datesHidden === true;

  const startDate = cleanText(body.startDate, 10);
  if (startDate === '') {
    return 'startDate';
  }
  const start = readDayAndTime(startDate, cleanText(body.startTime, 5), fields.timezone, DAY_START, { date: 'startDate', time: 'startTime' });
  if (!start.ok) {
    return start.field;
  }
  fields.starts_at = start.at;
  fields.start_time_tbc = start.timeTbc;

  const endTime = cleanText(body.endTime, 5);
  let endDate = cleanText(body.endDate, 10);
  if (endDate === '' && (endTime !== '' || start.timeTbc)) {
    endDate = startDate;
  }
  fields.ends_at = null;
  fields.end_time_tbc = false;
  if (endDate !== '') {
    const end = readDayAndTime(endDate, endTime, fields.timezone, DAY_END, { date: 'endDate', time: 'endTime' });
    if (!end.ok) {
      return end.field;
    }
    fields.ends_at = end.at;
    fields.end_time_tbc = end.timeTbc;
  }
  if (fields.ends_at && new Date(fields.ends_at) < new Date(fields.starts_at)) {
    if (endDate === startDate) {
      return 'endTime';
    }
    return 'endDate';
  }

  const publishWall = cleanText(body.publishLocal, 16);
  fields.publish_at = null;
  if (publishWall !== '') {
    fields.publish_at = wallToUtc(publishWall, fields.timezone);
    if (!fields.publish_at) {
      return 'publishLocal';
    }
  }
  return null;
}

// A location's text fields: [form field, key in the stored location, longest
// allowed].
const LOCATION_TEXT_FIELDS = [
  ['customLabel', 'custom_label', LIMITS.label],
  ['venueName', 'venue_name', LIMITS.venueName],
  ['venueAddress', 'venue_address', LIMITS.venueAddress],
  ['city', 'city', LIMITS.city],
  ['country', 'country', LIMITS.country],
];

// One location from the form as { ok: true, location } (location null when
// every field of it is blank, so an untouched row is dropped), or
// { ok: false, field }. labels: the labels it may have (the event's own
// places, or a meal's).
function readLocation(entry, labels = LOCATION_LABELS) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, field: 'locations' };
  }
  const location = { label: allowedOrNull(labels, entry.label) };
  if (!location.label) {
    return { ok: false, field: 'locationLabel' };
  }
  for (const [formField, key, maximumLength] of LOCATION_TEXT_FIELDS) {
    if (!putText(location, key, entry[formField], maximumLength).ok) {
      return { ok: false, field: formField };
    }
  }
  // A country picked from the list is a code; one typed before the list
  // existed is kept as it was.
  if (location.country && COUNTRY_CODE.test(location.country)) {
    location.country = location.country.toUpperCase();
  }
  const mapsLink = httpsUrl(entry.mapsUrl);
  if (!mapsLink.ok) {
    return { ok: false, field: 'mapsUrl' };
  }
  location.maps_url = mapsLink.url;

  if (location.label !== 'custom') {
    location.custom_label = null;
  }
  const placeKeys = ['venue_name', 'venue_address', 'city', 'country', 'maps_url'];
  if (placeKeys.every((key) => location[key] === null)) {
    return { ok: true, location: null };
  }
  if (location.label === 'custom' && !location.custom_label) {
    return { ok: false, field: 'customLabel' };
  }
  return { ok: true, location };
}

// The keys of a stored location (migrations/004), in order.
const LOCATION_KEYS = ['label', 'custom_label', 'venue_name', 'venue_address', 'city', 'country', 'maps_url'];

// An event's locations as stored, each with every key (a blank one null),
// so two versions compare equal whenever they say the same. An event saved
// before the list existed has its one place in the venue columns, which
// stand in as its only location.
export function storedLocations(row) {
  let locations = [];
  if (Array.isArray(row.locations) && row.locations.length) {
    locations = row.locations;
  } else if (row.venue_name || row.venue_address || row.city || row.country) {
    locations = [{ label: 'event', venue_name: row.venue_name, venue_address: row.venue_address, city: row.city, country: row.country }];
  }
  return locations.map(tidyLocation);
}

// A stored location with every key, a blank one null.
function tidyLocation(location) {
  const tidy = {};
  for (const key of LOCATION_KEYS) {
    tidy[key] = null;
    if (location && location[key] !== undefined && location[key] !== null && location[key] !== '') {
      tidy[key] = location[key];
    }
  }
  return tidy;
}

// A meal's own places as stored, each with every key, skipping anything
// malformed; empty when the meal is at the event's own place.
function storedMealLocations(locations) {
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations
    .filter((location) => {
      if (!location) {
        return false;
      }
      return MEAL_LOCATION_LABELS.includes(location.label);
    })
    .slice(0, MAX_MEAL_LOCATIONS)
    .map(tidyLocation);
}

// The main location: the first labelled as the event's own, or else the
// first of all; null when there are none.
export function mainLocation(locations) {
  const eventPlace = locations.find((location) => location.label === 'event');
  if (eventPlace) {
    return eventPlace;
  }
  if (locations.length) {
    return locations[0];
  }
  return null;
}

// The list of locations, at most MAX_LOCATIONS, each checked. The main one
// is also copied to the venue_name, venue_address, city and country columns,
// which the feed cards and the notices read (migrations/004).
//
// It returns the form field at the first problem, and sets
// fields.badLocation to that location's place in the list, so the answer
// can say which one (validateEvent).
function readLocations(body, fields) {
  let entries = body.locations;
  if (entries === undefined || entries === null) {
    entries = [];
  }
  if (!Array.isArray(entries) || entries.length > MAX_LOCATIONS) {
    return 'locations';
  }
  const locations = [];
  for (const [index, entry] of entries.entries()) {
    const check = readLocation(entry);
    if (!check.ok) {
      fields.badLocation = index;
      return check.field;
    }
    if (check.location) {
      locations.push(check.location);
    }
  }
  fields.locations = locations;

  const main = mainLocation(locations);
  for (const column of ['venue_name', 'venue_address', 'city', 'country']) {
    if (main) {
      fields[column] = main[column];
    } else {
      fields[column] = null;
    }
  }
  return null;
}

// The links on the form, and their columns.
const LINK_FIELDS = [
  ['externalUrl', 'external_url'],
  ['onlineUrl', 'online_url'],
];

// Online or not, who sees the address, and the two links (https only, blank
// is null). The cover picture is not a field here: it is uploaded on its own
// to the covers bucket (api/manage/cover.js, migrations/002).
function readPlaceAndLinks(body, fields) {
  fields.is_online = body.isOnline === true;
  fields.address_attendees_only = body.addressAttendeesOnly === true;
  for (const [formField, column] of LINK_FIELDS) {
    const check = httpsUrl(body[formField]);
    if (!check.ok) {
      return formField;
    }
    fields[column] = check.url;
  }
  return null;
}

// What the link button says (migrations/015) and whether the event is
// cross-border. A label the form does not know reads as "Tickets and
// website". The editor's own words are kept while another label is picked;
// 'custom' saves before they are typed (it is picked from a list, which
// saves at once), and the page says "Tickets and website" until they are.
// Without the fields (a page from before them) the stored ones are kept.
function readLinkLabelAndBorder(body, fields) {
  if (body.externalUrlLabel !== undefined) {
    fields.external_url_label = allowedOrNull(LINK_LABELS, body.externalUrlLabel);
    if (!fields.external_url_label) {
      fields.external_url_label = 'tickets_website';
    }
    const custom = cleanText(body.externalUrlCustomLabel, LIMITS.linkLabel);
    if (custom.length > LIMITS.linkLabel) {
      return 'externalUrlCustomLabel';
    }
    fields.external_url_custom_label = null;
    if (custom !== '') {
      fields.external_url_custom_label = custom;
    }
  }
  if (body.crossBorder !== undefined) {
    fields.cross_border = body.crossBorder === true;
  }
  return null;
}

// The price type, then the amounts and currency, which are kept only for a
// paid event. A paid event needs a minimum, the maximum cannot be below the
// minimum, and the currency defaults to SGD.
function readPrice(body, fields) {
  fields.price_type = allowedOrNull(PRICE_TYPES, body.priceType);
  if (!fields.price_type) {
    return 'priceType';
  }
  fields.price_hidden = body.priceHidden === true;

  const isPaid = fields.price_type === 'paid';
  // With ticket tiers on, the range comes from the tiers (readTiers), and
  // the form's own From and Up to fields are not read at all.
  let tiered = false;
  if (isPaid && body.tiersEnabled === true && body.ticketTiers !== undefined) {
    tiered = true;
  }
  fields.price_min = null;
  fields.price_max = null;
  if (isPaid && !tiered) {
    const minimumPrice = parseMoney(body.priceMin);
    if (!minimumPrice.ok) {
      return 'priceMin';
    }
    const maximumPrice = parseMoney(body.priceMax);
    if (!maximumPrice.ok) {
      return 'priceMax';
    }
    fields.price_min = minimumPrice.value;
    fields.price_max = maximumPrice.value;
  }
  if (isPaid && !tiered && fields.price_min === null) {
    return 'priceMin';
  }
  if (fields.price_max !== null && fields.price_min !== null && fields.price_max < fields.price_min) {
    return 'priceMax';
  }

  const currency = cleanText(body.currency, 3).toUpperCase();
  if (!isPaid) {
    fields.currency = null;
  } else if (currency) {
    fields.currency = currency;
  } else {
    fields.currency = 'SGD';
  }
  if (fields.currency && !/^[A-Z]{3}$/.test(fields.currency)) {
    return 'currency';
  }
  if (fields.currency && CURRENCIES.size && !CURRENCIES.has(fields.currency)) {
    return 'currency';
  }
  return null;
}

// Capacity: blank is no limit (null), otherwise a whole number from 1 to a
// million. RSVPs are open unless the form says false.
function readCapacity(body, fields) {
  if (body.capacity === undefined || body.capacity === null || body.capacity === '') {
    fields.capacity = null;
  } else {
    const capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
      return 'capacity';
    }
    fields.capacity = capacity;
  }
  fields.rsvp_open = body.rsvpOpen !== false;
  // Whether people going are asked if they are fursuiters (migrations/023),
  // on any kind of event. Without the field, the stored setting is kept.
  if (body.fursuitersAsked !== undefined) {
    fields.fursuiters_asked = body.fursuitersAsked === true;
  }
  return null;
}

// Whether an event asks the people going if they are fursuiters
// (migrations/023).
export function asksFursuiters(row) {
  if (!row) {
    return false;
  }
  if (row.fursuiters_asked === true) {
    return true;
  }
  return registrationAsksFursuiting(row);
}

// Whether the plain "I'm a fursuiter" tick box is shown: the event asks,
// and its registration form does not ask "Are you fursuiting?" itself
// (migrations/024, whose answer sets the same flag).
export function fursuiterTickShown(row) {
  if (!row) {
    return false;
  }
  if (row.fursuiters_asked !== true) {
    return false;
  }
  return !registrationAsksFursuiting(row);
}

// Whether a meal id is one an event can offer: breakfast, lunch, dinner, or
// a named meal's id.
function isMealId(id) {
  if (typeof id !== 'string') {
    return false;
  }
  if (BUILT_IN_MEALS.includes(id)) {
    return true;
  }
  return CUSTOM_MEAL_ID.test(id);
}

// An event's meals as stored (migrations/007 and 009), each { id, label,
// limit, locations } (label null for breakfast, lunch and dinner; limit null
// for no limit; locations the meal's own places, empty when it is at the
// event's), skipping anything malformed.
export function storedMeals(row) {
  if (!row || !Array.isArray(row.meal_options)) {
    return [];
  }
  const meals = [];
  for (const meal of row.meal_options) {
    if (!meal || !isMealId(meal.id)) {
      continue;
    }
    const limit = storedLimit(meal.limit);
    const locations = storedMealLocations(meal.locations);
    if (BUILT_IN_MEALS.includes(meal.id)) {
      meals.push({ id: meal.id, label: null, limit, locations });
    } else if (typeof meal.label === 'string' && meal.label !== '') {
      meals.push({ id: meal.id, label: meal.label, limit, locations });
    }
  }
  return meals;
}

// The most a meal's limit can be.
const MAX_MEAL_LIMIT = 1_000_000;

// A meal's limit as stored: a whole number from 1, or null for none.
function storedLimit(value) {
  if (Number.isInteger(value) && value >= 1 && value <= MAX_MEAL_LIMIT) {
    return value;
  }
  return null;
}

// { ok: true, limit } for a meal's limit from the form (blank: null, no
// limit), or { ok: false }.
function readMealLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, limit: null };
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEAL_LIMIT) {
    return { ok: false };
  }
  return { ok: true, limit };
}

// A choice of meals (ids) for an event: { ok: true, meals } with the ids in
// the event's own order and each once (an empty list is the whole event),
// or { ok: false } when it is not a list or names a meal the event does
// not offer.
export function chooseMeals(row, chosen) {
  if (chosen === undefined || chosen === null) {
    return { ok: true, meals: [] };
  }
  if (!Array.isArray(chosen) || chosen.length > BUILT_IN_MEALS.length + MAX_CUSTOM_MEALS) {
    return { ok: false };
  }
  const offered = storedMeals(row).map((meal) => meal.id);
  if (chosen.some((id) => !offered.includes(id))) {
    return { ok: false };
  }
  return { ok: true, meals: offered.filter((id) => chosen.includes(id)) };
}

// A meal's own places from the form ([] or missing: the meal is at the
// event's place), at most MAX_MEAL_LOCATIONS, each checked like one of the
// event's and an untouched one dropped: { ok: true, locations } or
// { ok: false, field, location } (that location's place in the list).
function readMealLocations(entries) {
  if (entries === undefined || entries === null) {
    return { ok: true, locations: [] };
  }
  if (!Array.isArray(entries) || entries.length > MAX_MEAL_LOCATIONS) {
    return { ok: false, field: 'mealLocations' };
  }
  const locations = [];
  for (const [index, entry] of entries.entries()) {
    const check = readLocation(entry, MEAL_LOCATION_LABELS);
    if (!check.ok) {
      return { ok: false, field: check.field, location: index };
    }
    if (check.location) {
      locations.push(check.location);
    }
  }
  return { ok: true, locations };
}

// The meals people can come to on their own: [{ id, label, limit,
// locations }] from the form, breakfast, lunch and dinner by id (and limit),
// a named meal with its id and name. A limit is how many can come for that
// meal alone (blank: no limit); people coming to the whole event do not
// count against it. locations are the meal's own places when it is held
// somewhere other than the event (readMealLocations; none: at the event's).
// They are stored with the three first, in that order, then the named ones
// as given. A named meal left blank is dropped, like an untouched location.
// With no meals field at all the stored ones are kept, so a page from before
// meal-only RSVPs cannot wipe what another editor set.
//
// A problem in one of a meal's places sets fields.badMeal to the meal's id
// and fields.badLocation to the place's position, so the answer can say
// which (validateEvent).
function readMeals(body, fields) {
  if (body.meals === undefined) {
    return null;
  }
  let entries = body.meals;
  if (entries === null) {
    entries = [];
  }
  if (!Array.isArray(entries) || entries.length > BUILT_IN_MEALS.length + MAX_CUSTOM_MEALS) {
    return 'meals';
  }
  const ticked = new Map();
  const named = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'meals';
    }
    const id = stringOrEmpty(entry.id);
    if (!isMealId(id) || seen.has(id)) {
      return 'meals';
    }
    seen.add(id);
    const limit = readMealLimit(entry.limit);
    if (!limit.ok) {
      return 'mealLimit';
    }
    const places = readMealLocations(entry.locations);
    if (!places.ok) {
      fields.badMeal = id;
      if (places.location !== undefined) {
        fields.badLocation = places.location;
      }
      return places.field;
    }
    if (BUILT_IN_MEALS.includes(id)) {
      ticked.set(id, { limit: limit.limit, locations: places.locations });
      continue;
    }
    const label = cleanText(entry.label, LIMITS.mealLabel);
    if (label.length > LIMITS.mealLabel) {
      return 'mealLabel';
    }
    if (label !== '') {
      named.push({ id, label, limit: limit.limit, locations: places.locations });
    }
  }
  if (named.length > MAX_CUSTOM_MEALS) {
    return 'meals';
  }
  fields.meal_options = [
    ...BUILT_IN_MEALS.filter((id) => ticked.has(id)).map((id) => ({ id, label: null, ...ticked.get(id) })),
    ...named,
  ];
  return null;
}

// One ticket tier from the form: { name, price, benefits (one per line),
// includes (another tier's id, or blank for none), previousDisplay,
// maxPerPerson (blank or 1 for once per person, up to MAX_PER_PERSON) },
// as { ok: true, tier } (tier null when
// it is left wholly blank, so an untouched card is dropped) or
// { ok: false, field }. A tier needs a name and a price (0 for a free tier).
function readTier(entry, timeZone = DEFAULT_TIMEZONE) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, field: 'ticketTiers' };
  }
  const name = cleanText(entry.name, LIMITS.tierName);
  if (name.length > LIMITS.tierName) {
    return { ok: false, field: 'tierName' };
  }
  let benefitText = entry.benefits;
  if (Array.isArray(benefitText)) {
    benefitText = benefitText.join('\n');
  }
  const benefits = [];
  for (const line of cleanText(benefitText, LIMITS.tierBenefit * MAX_TIER_BENEFITS * 2).split('\n')) {
    const benefit = line.trim();
    if (benefit.length > LIMITS.tierBenefit) {
      return { ok: false, field: 'tierBenefits' };
    }
    if (benefit !== '') {
      benefits.push(benefit);
    }
  }
  if (benefits.length > MAX_TIER_BENEFITS) {
    return { ok: false, field: 'tierBenefits' };
  }
  const price = parseMoney(entry.price);
  if (!price.ok) {
    return { ok: false, field: 'tierPrice' };
  }
  if (name === '' && price.value === null && benefits.length === 0) {
    return { ok: true, tier: null };
  }
  if (name === '') {
    return { ok: false, field: 'tierName' };
  }
  if (price.value === null) {
    return { ok: false, field: 'tierPrice' };
  }
  const most = readMaxPerPerson(entry.maxPerPerson);
  if (!most.ok) {
    return { ok: false, field: 'tierMaxPerPerson' };
  }
  let includes = null;
  if (typeof entry.includes === 'string' && TIER_ID.test(entry.includes)) {
    includes = entry.includes;
  }
  // A form from before tiers could include any tier sends includesPrevious.
  let includesPrevious = false;
  if (entry.includes === undefined && entry.includesPrevious === true) {
    includesPrevious = true;
  }
  let previousDisplay = allowedOrNull(PREVIOUS_DISPLAYS, entry.previousDisplay);
  if (!previousDisplay) {
    previousDisplay = 'reference';
  }
  // Its own ways to pay (migrations/016): any of PAYMENT_METHODS, none for
  // the event's own; its own payment link (blank for the event's). Its QR
  // code is uploaded on its own (api/manage/payment-qr.js) and kept by the
  // server across saves, by the tier's id.
  let methods = entry.paymentMethods;
  if (methods === undefined || methods === null) {
    methods = [];
  }
  if (!Array.isArray(methods) || methods.some((method) => !PAYMENT_METHODS.includes(method))) {
    return { ok: false, field: 'tierPaymentMethods' };
  }
  const link = httpsUrl(entry.paymentLink);
  if (!link.ok) {
    return { ok: false, field: 'tierPaymentLink' };
  }
  let id = entry.id;
  if (typeof id !== 'string' || !TIER_ID.test(id)) {
    id = newTierId();
  }
  // When it stops being sold (migrations/024): a wall time in the event's
  // zone, blank for never. Its holders can no longer change their
  // registration answers or upgrade from it once it has passed.
  let closesAt = null;
  const closesWall = cleanText(entry.closesLocal, 16);
  if (closesWall !== '') {
    closesAt = wallToUtc(closesWall, timeZone);
    if (!closesAt) {
      return { ok: false, field: 'tierClosesLocal' };
    }
  }
  return {
    ok: true,
    tier: {
      id,
      closes_at: closesAt,
      name,
      price: price.value,
      benefits,
      includes,
      includes_previous: includesPrevious,
      previous_display: previousDisplay,
      max_per_person: most.value,
      payment_methods: PAYMENT_METHODS.filter((method) => methods.includes(method)),
      payment_link: link.url,
      payment_qr_path: null,
    },
  };
}

// How many of a tier one person can buy: blank (or 1) for once, else 2 to
// MAX_PER_PERSON.
function readMaxPerPerson(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: 1 };
  }
  const most = Number(value);
  if (!Number.isInteger(most) || most < 1 || most > MAX_PER_PERSON) {
    return { ok: false };
  }
  return { ok: true, value: most };
}

// Each tier's includes made safe, in place: a tier from before tiers could
// include any tier (includes_previous) includes the one before it; one
// naming a tier that is not in the list, or itself, includes none; and a
// tier whose includes would go round in a loop back to itself includes
// none. includes_previous is then written to match, for a release from
// before.
function settleIncludes(tiers) {
  const ids = new Set(tiers.map((tier) => tier.id));
  tiers.forEach((tier, index) => {
    if (tier.includes === null && tier.includes_previous === true && index > 0) {
      tier.includes = tiers[index - 1].id;
    }
    if (!ids.has(tier.includes) || tier.includes === tier.id) {
      tier.includes = null;
    }
  });
  const byId = new Map(tiers.map((tier) => [tier.id, tier]));
  for (const tier of tiers) {
    const seen = new Set([tier.id]);
    let next = byId.get(tier.includes);
    while (next) {
      if (seen.has(next.id)) {
        tier.includes = null;
        break;
      }
      seen.add(next.id);
      next = byId.get(next.includes);
    }
  }
  tiers.forEach((tier, index) => {
    tier.includes_previous = false;
    if (index > 0 && tier.includes === tiers[index - 1].id) {
      tier.includes_previous = true;
    }
  });
  return tiers;
}

// The tiers a tier includes, nearest first (the one it names, then the one
// that names, and so on). tiers: storedTiers(row).
export function includedTiers(tiers, tier) {
  const byId = new Map(tiers.map((each) => [each.id, each]));
  const chain = [];
  const seen = new Set([tier.id]);
  let next = byId.get(tier.includes);
  while (next && !seen.has(next.id)) {
    chain.push(next);
    seen.add(next.id);
    next = byId.get(next.includes);
  }
  return chain;
}

// A tier's id: "t-" and 4 to 16 lowercase letters or digits. The edit form
// makes one for each new tier; one stored before tiers had ids gets one from
// its place in the list (storedTiers), the same each time it is read.
const TIER_ID = /^t-[a-z0-9]{4,16}$/;

function newTierId() {
  return `t-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

// Ticket tiers (migrations/008): the list, each checked, and whether they are
// on. They are on only for a paid event, and then there must be at least
// and the cheapest and dearest prices become the price range the feed cards
// show. A tier includes another one in the list or none (settleIncludes).
// With no
// ticketTiers field at all the stored tiers are kept, so a page from before
// tiers cannot wipe them.
//
// It returns the form field at the first problem, and sets fields.badTier to
// that tier's place in the list, so the answer can say which one.
function readTiers(body, fields) {
  if (body.ticketTiers === undefined) {
    return null;
  }
  let entries = body.ticketTiers;
  if (entries === null) {
    entries = [];
  }
  if (!Array.isArray(entries) || entries.length > MAX_TIERS) {
    return 'ticketTiers';
  }
  const tiers = [];
  for (const [index, entry] of entries.entries()) {
    const check = readTier(entry, fields.timezone);
    if (!check.ok) {
      fields.badTier = index;
      return check.field;
    }
    if (check.tier) {
      tiers.push(check.tier);
    }
  }
  // Two tiers with one id (a copied form): the second gets a new one.
  const ids = new Set();
  for (const tier of tiers) {
    if (ids.has(tier.id)) {
      tier.id = newTierId();
    }
    ids.add(tier.id);
  }
  fields.ticket_tiers = settleIncludes(tiers);
  fields.tiers_enabled = false;
  if (body.tiersEnabled === true && fields.price_type === 'paid') {
    fields.tiers_enabled = true;
  }
  // On with no tiers yet (just switched on, nothing typed): no range, so
  // the price reads "to be announced" until the first tier is filled in.
  if (!fields.tiers_enabled || tiers.length === 0) {
    return null;
  }
  const prices = tiers.map((tier) => tier.price);
  fields.price_min = Math.min(...prices);
  fields.price_max = null;
  if (Math.max(...prices) > fields.price_min) {
    fields.price_max = Math.max(...prices);
  }
  return null;
}

// An event's tiers as stored, each with every key, skipping anything
// malformed.
export function storedTiers(row) {
  if (!row || !Array.isArray(row.ticket_tiers)) {
    return [];
  }
  const tiers = [];
  for (const tier of row.ticket_tiers) {
    if (!tier || typeof tier.name !== 'string' || tier.name === '') {
      continue;
    }
    let benefits = [];
    if (Array.isArray(tier.benefits)) {
      benefits = tier.benefits.filter((benefit) => {
        if (typeof benefit !== 'string') {
          return false;
        }
        return benefit !== '';
      });
    }
    let previousDisplay = 'reference';
    if (tier.previous_display === 'full') {
      previousDisplay = 'full';
    }
    let price = Number(tier.price);
    if (!Number.isFinite(price)) {
      price = 0;
    }
    let id = tier.id;
    if (typeof id !== 'string' || !TIER_ID.test(id)) {
      id = `t-tier${tiers.length + 1}`;
    }
    let methods = [];
    if (Array.isArray(tier.payment_methods)) {
      methods = PAYMENT_METHODS.filter((method) => tier.payment_methods.includes(method));
    }
    let link = null;
    if (typeof tier.payment_link === 'string' && tier.payment_link.startsWith('https://')) {
      link = tier.payment_link;
    }
    let qrPath = null;
    if (typeof tier.payment_qr_path === 'string' && tier.payment_qr_path.startsWith('qr/')) {
      qrPath = tier.payment_qr_path;
    }
    let includes = null;
    if (typeof tier.includes === 'string' && TIER_ID.test(tier.includes)) {
      includes = tier.includes;
    }
    let most = Number(tier.max_per_person);
    if (!Number.isInteger(most) || most < 1) {
      most = 1;
    }
    let closesAt = null;
    if (typeof tier.closes_at === 'string' && Number.isFinite(Date.parse(tier.closes_at))) {
      closesAt = tier.closes_at;
    }
    tiers.push({
      id,
      closes_at: closesAt,
      name: tier.name,
      price,
      benefits,
      includes,
      includes_previous: tier.includes_previous === true,
      previous_display: previousDisplay,
      max_per_person: Math.min(most, MAX_PER_PERSON),
      payment_methods: methods,
      payment_link: link,
      payment_qr_path: qrPath,
    });
  }
  return settleIncludes(tiers);
}

// Whether a tier has stopped being sold (migrations/024): its closing time
// has come.
export function tierClosed(tier, now = Date.now()) {
  if (!tier || !tier.closes_at) {
    return false;
  }
  return Date.parse(tier.closes_at) <= now;
}

// Volunteers (migrations/012), for a convention only: whether it takes
// volunteer sign-ups, and the benefit it gives the people who volunteered at
// an earlier convention (which one, a percentage or an amount, and how
// much). Any other kind of event has both switched off; its stored benefit
// settings are kept, like tiers, so switching back brings them back.
//
// The benefit may be switched on before the convention or the value is
// filled in, so autosave never refuses the tick box: it is in effect only
// once both are there (volunteerDiscountActive). The API checks that the
// convention named exists, is a convention and is not this event
// (api/manage/events.js). With none of these fields at all the stored ones
// are kept, so a page from before volunteers cannot wipe them.
function readVolunteers(body, fields) {
  const isConvention = fields.kind === VOLUNTEER_KIND;
  const given = ['volunteersWanted', 'volunteerDiscountEnabled', 'volunteerDiscountFrom', 'volunteerDiscountType', 'volunteerDiscountValue']
    .some((name) => body[name] !== undefined);
  if (!given) {
    if (!isConvention) {
      fields.volunteers_wanted = false;
      fields.volunteer_discount_enabled = false;
    }
    return null;
  }
  fields.volunteers_wanted = false;
  fields.volunteer_discount_enabled = false;
  if (isConvention) {
    fields.volunteers_wanted = body.volunteersWanted === true;
    fields.volunteer_discount_enabled = body.volunteerDiscountEnabled === true;
  }

  const from = cleanText(body.volunteerDiscountFrom, 36).toLowerCase();
  if (from !== '' && !UUID.test(from)) {
    return 'volunteerDiscountFrom';
  }
  fields.volunteer_discount_from = null;
  if (from !== '') {
    fields.volunteer_discount_from = from;
  }

  fields.volunteer_discount_type = allowedOrNull(DISCOUNT_TYPES, body.volunteerDiscountType);
  if (!fields.volunteer_discount_type) {
    fields.volunteer_discount_type = 'percent';
  }
  const value = parseMoney(body.volunteerDiscountValue);
  if (!value.ok) {
    return 'volunteerDiscountValue';
  }
  if (fields.volunteer_discount_type === 'percent' && value.value !== null && value.value > 100) {
    return 'volunteerDiscountValue';
  }
  fields.volunteer_discount_value = value.value;
  return null;
}

// Whether an event's volunteer benefit is in effect: a convention, with it
// switched on, an earlier convention picked and a value above 0.
export function volunteerDiscountActive(row) {
  if (!row || row.kind !== VOLUNTEER_KIND || row.volunteer_discount_enabled !== true) {
    return false;
  }
  if (!row.volunteer_discount_from) {
    return false;
  }
  return Number(row.volunteer_discount_value) > 0;
}

// Whether an event takes volunteer sign-ups: a convention that says so.
export function takesVolunteers(row) {
  if (!row || row.kind !== VOLUNTEER_KIND) {
    return false;
  }
  return row.volunteers_wanted === true;
}

// ---------------------------------------------------------------------------
// Payment methods and checkout (migrations/016). A paid event takes payment
// on the day (onsite), by a link the editor pastes, or by a QR code the
// editor uploads, any one or more. With link or qr on, getting a ticket goes
// through /checkout, for one ticket for the whole event; people coming just
// for a meal pay nothing here.
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = ['onsite', 'link', 'qr'];
// The methods paid outside this site, which a checkout reserves a place for
// and an editor then checks.
export const ONLINE_METHODS = ['link', 'qr'];
export const PAYMENT_STATUSES = ['none', 'awaiting', 'submitted', 'paid'];

// The payment fields: which methods are ticked, the link and the
// instructions. Ticking a method is never refused, so autosave keeps up
// with the editor: one that cannot be used yet (no link, no QR code, no
// single price to pay) is simply not offered at checkout, and the form says
// why (paymentProblems). The QR code itself is uploaded on its own
// (api/manage/payment-qr.js). With none of these fields at all the stored
// ones are kept, so a page from before checkout cannot wipe them.
function readPayment(body, fields) {
  const given = ['paymentMethods', 'paymentLink', 'paymentInstructions'].some((name) => body[name] !== undefined);
  if (!given) {
    return null;
  }
  let methods = body.paymentMethods;
  if (methods === null || methods === undefined) {
    methods = [];
  }
  if (!Array.isArray(methods) || methods.some((method) => !PAYMENT_METHODS.includes(method))) {
    return 'paymentMethods';
  }
  // In a fixed order, each once.
  fields.payment_methods = PAYMENT_METHODS.filter((method) => methods.includes(method));
  const link = httpsUrl(body.paymentLink);
  if (!link.ok) {
    return 'paymentLink';
  }
  fields.payment_link = link.url;
  const instructions = cleanText(body.paymentInstructions, LIMITS.paymentInstructions);
  if (instructions.length > LIMITS.paymentInstructions) {
    return 'paymentInstructions';
  }
  fields.payment_instructions = null;
  if (instructions !== '') {
    fields.payment_instructions = instructions;
  }
  return null;
}

function storedMethods(row) {
  if (!row || !Array.isArray(row.payment_methods)) {
    return [];
  }
  return PAYMENT_METHODS.filter((method) => row.payment_methods.includes(method));
}

// Whether a paid event has one amount to pay: a ticket tier picked at
// checkout, or a single price with no Up to. A range without tiers has none.
function hasSingleAmount(row) {
  if (row.tiers_enabled === true && storedTiers(row).length > 0) {
    return true;
  }
  if (row.price_min === null || row.price_min === undefined) {
    return false;
  }
  if (row.price_max === null || row.price_max === undefined) {
    return true;
  }
  return false;
}

// Whether an event sells its tickets in tiers (with at least one tier).
export function sellsTiers(row) {
  if (row.tiers_enabled !== true) {
    return false;
  }
  return storedTiers(row).length > 0;
}

// A tier's ways to pay as ticked: its own, or the event's when it ticks
// none. tier: one of storedTiers(row).
export function tierMethods(row, tier) {
  if (tier.payment_methods.length > 0) {
    return tier.payment_methods;
  }
  return storedMethods(row);
}

// The payment link and QR code (Storage path) a tier's buyers use: its own,
// or the event's. null when there is none.
export function tierLink(row, tier) {
  if (tier && tier.payment_link) {
    return tier.payment_link;
  }
  if (row.payment_link) {
    return row.payment_link;
  }
  return null;
}

export function tierQrPath(row, tier) {
  if (tier && tier.payment_qr_path) {
    return tier.payment_qr_path;
  }
  if (row.payment_qr_path) {
    return row.payment_qr_path;
  }
  return null;
}

// The tier someone's ticket is for, by the name kept at checkout, or null.
export function tierNamed(row, name) {
  if (!sellsTiers(row) || !name) {
    return null;
  }
  const match = storedTiers(row).find((tier) => tier.name === name);
  if (!match) {
    return null;
  }
  return match;
}

// The ways a tier can be paid for now, in order: onsite whenever ticked,
// link and qr once there is a link or QR code for it (its own or the
// event's). Empty for an event that is not paid.
export function tierOptions(row, tier) {
  if (!row || row.price_type !== 'paid') {
    return [];
  }
  return tierMethods(row, tier).filter((method) => {
    if (method === 'onsite') {
      return true;
    }
    if (method === 'link') {
      return tierLink(row, tier) !== null;
    }
    return tierQrPath(row, tier) !== null;
  });
}

// Why each ticked online method cannot be offered yet, for the edit form:
// a list of { code, tier }, code one of 'not_paid', 'no_single_price',
// 'no_link' and 'no_qr', tier the tier's name for a tier's own ways to pay
// (null for the event's). Empty when every ticked method works.
export function paymentProblems(row) {
  const problems = [];
  const tiers = [];
  if (sellsTiers(row)) {
    tiers.push(...storedTiers(row));
  }
  const ticked = [storedMethods(row), ...tiers.map((tier) => tierMethods(row, tier))].flat();
  if (!ticked.some((method) => ONLINE_METHODS.includes(method))) {
    return problems;
  }
  if (row.price_type !== 'paid') {
    problems.push({ code: 'not_paid', tier: null });
    return problems;
  }
  if (tiers.length === 0) {
    const methods = storedMethods(row);
    if (!hasSingleAmount(row)) {
      problems.push({ code: 'no_single_price', tier: null });
    }
    if (methods.includes('link') && !row.payment_link) {
      problems.push({ code: 'no_link', tier: null });
    }
    if (methods.includes('qr') && !row.payment_qr_path) {
      problems.push({ code: 'no_qr', tier: null });
    }
    return problems;
  }
  for (const tier of tiers) {
    const methods = tierMethods(row, tier);
    if (methods.includes('link') && tierLink(row, tier) === null) {
      problems.push({ code: 'no_link', tier: tier.name });
    }
    if (methods.includes('qr') && tierQrPath(row, tier) === null) {
      problems.push({ code: 'no_qr', tier: tier.name });
    }
  }
  return problems;
}

// The methods a checkout offers for this event, in order: with tiers, every
// way any tier can be paid for (tierOptions); without, onsite whenever it is
// ticked, link and qr only once they can be used. Empty for an event that is
// not paid.
export function paymentOptions(row) {
  if (!row || row.price_type !== 'paid') {
    return [];
  }
  if (sellsTiers(row)) {
    const offered = storedTiers(row).flatMap((tier) => tierOptions(row, tier));
    return PAYMENT_METHODS.filter((method) => offered.includes(method));
  }
  const methods = storedMethods(row);
  const single = hasSingleAmount(row);
  return methods.filter((method) => {
    if (method === 'onsite') {
      return true;
    }
    if (!single) {
      return false;
    }
    if (method === 'link') {
      return Boolean(row.payment_link);
    }
    return Boolean(row.payment_qr_path);
  });
}

// The ways a basket of tiers can be paid for together, in order: those
// every tier in it takes, a link only when they all pay through the same
// one, and a QR code only when they all use the same one (one payment pays
// for the lot). Empty when they have no way in common.
export function basketOptions(row, tiers) {
  if (tiers.length === 0) {
    return [];
  }
  return tierOptions(row, tiers[0]).filter((method) => {
    if (!tiers.every((tier) => tierOptions(row, tier).includes(method))) {
      return false;
    }
    if (method === 'link') {
      return new Set(tiers.map((tier) => tierLink(row, tier))).size === 1;
    }
    if (method === 'qr') {
      return new Set(tiers.map((tier) => tierQrPath(row, tier))).size === 1;
    }
    return true;
  });
}

// The tiers someone's ticket is for: by id from what checkout kept
// (payment_items, migrations/022), or by the one tier name kept before
// that. Tiers since removed are left out. stored: their attendee row.
export function heldTiers(row, stored) {
  if (!sellsTiers(row) || !stored) {
    return [];
  }
  const tiers = storedTiers(row);
  if (Array.isArray(stored.payment_items) && stored.payment_items.length > 0) {
    return stored.payment_items
      .filter(isObject)
      .map((item) => tiers.find((tier) => tier.id === item.id))
      .filter(Boolean);
  }
  const named = tierNamed(row, stored.payment_tier);
  if (named) {
    return [named];
  }
  return [];
}

function isObject(value) {
  if (value === null) {
    return false;
  }
  return typeof value === 'object';
}

// The ways someone holding a ticket can pay for it: their tiers' (as one
// basket), or the event's.
export function ticketOptions(row, stored) {
  const tiers = heldTiers(row, stored);
  if (tiers.length > 0) {
    return basketOptions(row, tiers);
  }
  return paymentOptions(row);
}

// Whether getting a ticket for the whole event goes through /checkout: a
// paid event with link or qr ready to use. With only onsite (or nothing)
// ticked, the RSVP button on the event page works as it always has.
export function needsCheckout(row) {
  return paymentOptions(row).some((method) => ONLINE_METHODS.includes(method));
}

// What one ticket costs this person: { ok: true, tier, price, amount,
// discount } (tier: the tier's name or null; price: before the volunteer
// benefit; discount: what the benefit takes off, 0 when none), or { ok:
// false, error }. tierIndex and tierName name the tier picked (both, so a
// tier list that changed meanwhile is caught); ignored without tiers.
// volunteerDiscount: whether this person gets the event's volunteer benefit
// (events.js volunteerStanding).
export function ticketPrice(row, { tierIndex = null, tierName = null, volunteerDiscount = false, ignoreClosed = false } = {}) {
  let tier = null;
  let price;
  const tiers = storedTiers(row);
  if (row.tiers_enabled === true && tiers.length > 0) {
    if (!Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex >= tiers.length) {
      return { ok: false, error: 'tier_required' };
    }
    if (tiers[tierIndex].name !== tierName) {
      return { ok: false, error: 'tier_changed' };
    }
    if (!ignoreClosed && tierClosed(tiers[tierIndex])) {
      return { ok: false, error: 'tier_closed' };
    }
    tier = tiers[tierIndex].name;
    price = tiers[tierIndex].price;
  } else if (hasSingleAmount(row)) {
    price = Number(row.price_min);
  } else {
    return { ok: false, error: 'payment_unavailable' };
  }
  const discount = volunteerOff(row, price, volunteerDiscount);
  const amount = Math.round((price - discount) * 100) / 100;
  return { ok: true, tier, price, amount, discount };
}

// The volunteer benefit on an amount: what it takes off, rounded to cents.
function volunteerOff(row, price, volunteerDiscount) {
  let discount = 0;
  if (volunteerDiscount && volunteerDiscountActive(row)) {
    const value = Number(row.volunteer_discount_value);
    if (row.volunteer_discount_type === 'amount') {
      discount = Math.min(price, value);
    } else {
      discount = (price * Math.min(value, 100)) / 100;
    }
  }
  return Math.round(discount * 100) / 100;
}

// What a basket of tiers costs this person (migrations/022): items, from
// the checkout page, a list of { tier (its place in the list), tierName
// (so a list that changed meanwhile is caught), quantity }. Each tier at
// most once in the list, and more than one of it only up to its
// max_per_person. The volunteer benefit comes off the total once.
//
// -> { ok: true, tiers, items: [{ id, name, quantity, price }], text,
// price, amount, discount } (text: the tiers in words, "Day pass × 2,
// Dinner", as kept in payment_tier), or { ok: false, error }.
export function basketPrice(row, items, { volunteerDiscount = false, now = Date.now(), allowClosed = [] } = {}) {
  const tiers = storedTiers(row);
  if (!sellsTiers(row)) {
    return { ok: false, error: 'payment_unavailable' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'tier_required' };
  }
  if (items.length > tiers.length) {
    return { ok: false, error: 'bad_request' };
  }
  const picked = [];
  const chosen = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'bad_request' };
    }
    const index = item.tier;
    if (!Number.isInteger(index) || index < 0 || index >= tiers.length) {
      return { ok: false, error: 'tier_required' };
    }
    const tier = tiers[index];
    if (tier.name !== item.tierName) {
      return { ok: false, error: 'tier_changed' };
    }
    if (chosen.includes(tier)) {
      return { ok: false, error: 'bad_request' };
    }
    // A closed tier is not sold (migrations/024), except one already held
    // that an upgrade keeps (allowClosed: tier ids).
    if (tierClosed(tier, now) && !allowClosed.includes(tier.id)) {
      return { ok: false, error: 'tier_closed' };
    }
    let quantity = 1;
    if (item.quantity !== undefined) {
      quantity = item.quantity;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > tier.max_per_person) {
      return { ok: false, error: 'tier_quantity' };
    }
    chosen.push(tier);
    picked.push({ id: tier.id, name: tier.name, quantity, price: tier.price });
  }
  // In the event's own order, whatever order they came in.
  const place = (id) => tiers.findIndex((tier) => tier.id === id);
  picked.sort((first, second) => place(first.id) - place(second.id));
  chosen.sort((first, second) => place(first.id) - place(second.id));
  const price = Math.round(picked.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100;
  const discount = volunteerOff(row, price, volunteerDiscount);
  const amount = Math.round((price - discount) * 100) / 100;
  return { ok: true, tiers: chosen, items: picked, text: basketText(picked), price, amount, discount };
}

// A basket's tiers in words: "Day pass × 2, Dinner".
export function basketText(items) {
  return items.map((item) => {
    if (item.quantity > 1) {
      return `${item.name} × ${item.quantity}`;
    }
    return item.name;
  }).join(', ');
}

// ---------------------------------------------------------------------------
// "Just Lepak Only" (migrations/017): coming to a paid event without a
// ticket, to hang out, with meals if they like. Takes none of the event's
// spaces; the editor can cap how many it takes and rename the choice.
// ---------------------------------------------------------------------------

export const DEFAULT_LEPAK_LABEL = 'Just Lepak Only';

// The lepak fields: switched on, the cap (blank for none) and the editor's
// own words (blank: "Just Lepak Only"). Never refused for a free event: it
// is offered only while the event is paid (lepakOffered), and kept for when
// it is paid again. With none of these fields at all the stored ones are
// kept, so a page from before lepak cannot wipe them.
function readLepak(body, fields) {
  const given = ['lepakEnabled', 'lepakLimit', 'lepakLabel'].some((name) => body[name] !== undefined);
  if (!given) {
    return null;
  }
  fields.lepak_enabled = body.lepakEnabled === true;
  const limit = readMealLimit(body.lepakLimit);
  if (!limit.ok) {
    return 'lepakLimit';
  }
  fields.lepak_limit = limit.limit;
  const label = cleanText(body.lepakLabel, LIMITS.lepakLabel);
  if (label.length > LIMITS.lepakLabel) {
    return 'lepakLabel';
  }
  fields.lepak_label = null;
  if (label !== '') {
    fields.lepak_label = label;
  }
  return null;
}

// The contact details the event asks the people going for
// (migrations/021, js/contact-fields.js): the fields and the rule. With
// neither field at all the stored ones are kept, so a page from before
// cannot wipe them.
function readContact(body, fields) {
  if (body.contactFields === undefined && body.contactRule === undefined) {
    return null;
  }
  const read = readContactFields(body.contactFields);
  if (!read.ok) {
    if (Number.isInteger(read.index)) {
      fields.badContact = read.index;
    }
    return read.field;
  }
  const rule = readContactRule(body.contactRule);
  if (rule === null) {
    return 'contactRule';
  }
  fields.contact_fields = read.fields;
  fields.contact_rule = rule;
  return null;
}

// The registration form (migrations/024, js/registration-fields.js):
// switched on or not, and its questions, kept while it is off. With neither
// field at all the stored ones are kept, so a page from before cannot wipe
// them.
function readRegistration(body, fields) {
  if (body.registrationEnabled !== undefined) {
    fields.registration_enabled = body.registrationEnabled === true;
  }
  if (body.registrationFields === undefined) {
    return null;
  }
  const read = readRegistrationFields(body.registrationFields);
  if (!read.ok) {
    if (Number.isInteger(read.index)) {
      fields.badRegistration = read.index;
    }
    return read.field;
  }
  fields.registration_fields = read.fields;
  return null;
}

// Whether an event takes lepak RSVPs: a paid event with it switched on.
export function lepakOffered(row) {
  if (!row || row.lepak_enabled !== true) {
    return false;
  }
  return row.price_type === 'paid';
}

// What the choice says: the editor's words, or "Just Lepak Only".
export function lepakLabel(row) {
  if (row && typeof row.lepak_label === 'string' && row.lepak_label.trim() !== '') {
    return row.lepak_label;
  }
  return DEFAULT_LEPAK_LABEL;
}

// The lepak cap as stored, or null for none.
export function lepakLimit(row) {
  return storedLimit(row.lepak_limit);
}

// A payment reference as typed: { ok: true, reference } (null when blank)
// or { ok: false }.
export function readPaymentReference(value) {
  const reference = cleanText(value, LIMITS.paymentReference);
  if (reference.length > LIMITS.paymentReference) {
    return { ok: false };
  }
  if (reference === '') {
    return { ok: true, reference: null };
  }
  return { ok: true, reference };
}

// ---------------------------------------------------------------------------
// Timetables (migrations/014). Rooms are the grid's columns, in order; items
// are what happens, each on a day at a start time, with an optional end
// (earlier than the start: the next day), room and note. Days and times are
// wall-clock in the event's own zone, as the form shows them.
// ---------------------------------------------------------------------------

// One room from the form: { id, name, tag }, as { ok: true, room } (room
// null when its name and tag are both blank, so an untouched row is
// dropped) or { ok: false, field }.
function readRoom(entry, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, field: 'timetableRooms' };
  }
  const id = stringOrEmpty(entry.id);
  if (!ROOM_ID.test(id) || seen.has(id)) {
    return { ok: false, field: 'timetableRooms' };
  }
  seen.add(id);
  const name = cleanText(entry.name, LIMITS.roomName);
  if (name.length > LIMITS.roomName) {
    return { ok: false, field: 'roomName' };
  }
  const tag = cleanText(entry.tag, LIMITS.roomTag);
  if (tag.length > LIMITS.roomTag) {
    return { ok: false, field: 'roomTag' };
  }
  if (name === '' && tag === '') {
    return { ok: true, room: null };
  }
  if (name === '') {
    return { ok: false, field: 'roomName' };
  }
  let storedTag = null;
  if (tag !== '') {
    storedTag = tag;
  }
  return { ok: true, room: { id, name, tag: storedTag } };
}

// One item from the form: { title, date, start, end, room, note }, as
// { ok: true, item } (item null when its title, times and note are all
// blank: a new card the form filled the day in for, untouched) or
// { ok: false, field }. An item needs a title, a day and a start time; the
// end may be blank, and cannot be the start itself. A room no longer in the
// list (removed while this was being typed) leaves the item in none.
function readItem(entry, roomIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, field: 'timetableItems' };
  }
  const title = cleanText(entry.title, LIMITS.itemTitle);
  if (title.length > LIMITS.itemTitle) {
    return { ok: false, field: 'itemTitle' };
  }
  const note = cleanText(entry.note, LIMITS.itemNote);
  if (note.length > LIMITS.itemNote) {
    return { ok: false, field: 'itemNote' };
  }
  const date = cleanText(entry.date, 10);
  const start = cleanText(entry.start, 5);
  const end = cleanText(entry.end, 5);
  if (title === '' && start === '' && end === '' && note === '') {
    return { ok: true, item: null };
  }
  if (title === '') {
    return { ok: false, field: 'itemTitle' };
  }
  if (!isCalendarDate(date)) {
    return { ok: false, field: 'itemDate' };
  }
  if (!TIME_ONLY.test(start)) {
    return { ok: false, field: 'itemStart' };
  }
  if (end !== '' && (!TIME_ONLY.test(end) || end === start)) {
    return { ok: false, field: 'itemEnd' };
  }
  let room = stringOrEmpty(entry.room);
  if (!roomIds.has(room)) {
    room = null;
  }
  let storedEnd = null;
  if (end !== '') {
    storedEnd = end;
  }
  let storedNote = null;
  if (note !== '') {
    storedNote = note;
  }
  return { ok: true, item: { title, date, start, end: storedEnd, room, note: storedNote } };
}

// Items in time order: by day, then start time, then the order of their
// rooms (an item in no room last), keeping the editor's order otherwise.
function sortItems(items, rooms) {
  const roomOrder = new Map(rooms.map((room, index) => [room.id, index]));
  const place = (item) => {
    if (item.room !== null && roomOrder.has(item.room)) {
      return roomOrder.get(item.room);
    }
    return rooms.length;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((first, second) => {
      const firstKey = `${first.item.date}T${first.item.start}`;
      const secondKey = `${second.item.date}T${second.item.start}`;
      if (firstKey !== secondKey) {
        if (firstKey < secondKey) {
          return -1;
        }
        return 1;
      }
      const byRoom = place(first.item) - place(second.item);
      if (byRoom !== 0) {
        return byRoom;
      }
      return first.index - second.index;
    })
    .map((each) => each.item);
}

// The timetable (migrations/014): how the page shows it, the rooms and the
// items, each checked, the items put in time order. With none of its fields
// at all the stored timetable is kept, so a page from before timetables
// cannot wipe it; the three are always sent together.
//
// It returns the form field at the first problem, and sets fields.badRoom or
// fields.badItem to that room's or item's place in the list, so the answer
// can say which one.
function readTimetable(body, fields) {
  const given = ['timetableView', 'timetableRooms', 'timetableItems'].some((name) => body[name] !== undefined);
  if (!given) {
    return null;
  }
  fields.timetable_view = allowedOrNull(TIMETABLE_VIEWS, body.timetableView);
  if (!fields.timetable_view) {
    fields.timetable_view = 'timeline';
  }

  let roomEntries = body.timetableRooms;
  if (roomEntries === null || roomEntries === undefined) {
    roomEntries = [];
  }
  if (!Array.isArray(roomEntries) || roomEntries.length > MAX_ROOMS) {
    return 'timetableRooms';
  }
  const rooms = [];
  const seen = new Set();
  for (const [index, entry] of roomEntries.entries()) {
    const check = readRoom(entry, seen);
    if (!check.ok) {
      fields.badRoom = index;
      return check.field;
    }
    if (check.room) {
      rooms.push(check.room);
    }
  }

  let itemEntries = body.timetableItems;
  if (itemEntries === null || itemEntries === undefined) {
    itemEntries = [];
  }
  if (!Array.isArray(itemEntries) || itemEntries.length > MAX_TIMETABLE_ITEMS) {
    return 'timetableItems';
  }
  const roomIds = new Set(rooms.map((room) => room.id));
  const items = [];
  for (const [index, entry] of itemEntries.entries()) {
    const check = readItem(entry, roomIds);
    if (!check.ok) {
      fields.badItem = index;
      return check.field;
    }
    if (check.item) {
      items.push(check.item);
    }
  }
  fields.timetable_rooms = rooms;
  fields.timetable_items = sortItems(items, rooms);
  return null;
}

// An event's timetable as stored: { view, rooms, items }, each room and item
// with every key, skipping anything malformed, and an item's room null when
// that room is not in the list.
export function storedTimetable(row) {
  let view = 'timeline';
  if (row && row.timetable_view === 'grid') {
    view = 'grid';
  }
  const rooms = [];
  if (row && Array.isArray(row.timetable_rooms)) {
    for (const room of row.timetable_rooms) {
      if (!room || typeof room.id !== 'string' || !ROOM_ID.test(room.id)) {
        continue;
      }
      if (typeof room.name !== 'string' || room.name === '') {
        continue;
      }
      let tag = null;
      if (typeof room.tag === 'string' && room.tag !== '') {
        tag = room.tag;
      }
      rooms.push({ id: room.id, name: room.name, tag });
    }
  }
  const roomIds = new Set(rooms.map((room) => room.id));
  const items = [];
  if (row && Array.isArray(row.timetable_items)) {
    for (const item of row.timetable_items) {
      if (!item || typeof item.title !== 'string' || item.title === '') {
        continue;
      }
      if (typeof item.date !== 'string' || !isCalendarDate(item.date)) {
        continue;
      }
      if (typeof item.start !== 'string' || !TIME_ONLY.test(item.start)) {
        continue;
      }
      let end = null;
      if (typeof item.end === 'string' && TIME_ONLY.test(item.end) && item.end !== item.start) {
        end = item.end;
      }
      let room = null;
      if (typeof item.room === 'string' && roomIds.has(item.room)) {
        room = item.room;
      }
      let note = null;
      if (typeof item.note === 'string' && item.note !== '') {
        note = item.note;
      }
      items.push({ title: item.title, date: item.date, start: item.start, end, room, note });
    }
  }
  return { view, rooms, items };
}

// The day after a calendar date: "2026-12-31" -> "2027-01-01".
export function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

// When one stored item starts and ends, in UTC, in the event's zone:
// { startsAt, endsAt, endsNextDay } (endsAt null when it has no end). An
// end earlier than the start is on the next day.
export function itemTimes(item, timeZone) {
  const startsAt = wallToUtc(`${item.date}T${item.start}`, timeZone);
  let endsAt = null;
  let endsNextDay = false;
  if (item.end !== null) {
    let endDate = item.date;
    if (item.end < item.start) {
      endDate = nextDate(item.date);
      endsNextDay = true;
    }
    endsAt = wallToUtc(`${endDate}T${item.end}`, timeZone);
  }
  return { startsAt, endsAt, endsNextDay };
}

// The steps, in order. The order decides which field is reported when more
// than one is wrong, and later steps read columns earlier ones wrote (the
// times need the time zone).
const VALIDATION_STEPS = [readIdentity, readTextFields, readTimes, readLocations, readPlaceAndLinks, readLinkLabelAndBorder, readPrice, readTiers, readPayment, readLepak, readContact, readRegistration, readCapacity, readMeals, readVolunteers, readTimetable];

// { ok: true, fields } with the columns to write, or
// { ok: false, error: 'invalid_field', field } naming the first form field
// that is wrong, plus location (its place in the list, from 0) when that
// field is one location's, tier when it is one ticket tier's, meal (its
// id) when it is one of a meal's places or the list of them, and room or
// item (its place in the list, from 0) when it is one timetable room's or
// item's.
export function validateEvent(input) {
  let body = {};
  if (input && typeof input === 'object') {
    body = input;
  }
  const fields = {};
  for (const step of VALIDATION_STEPS) {
    const badField = step(body, fields);
    if (badField !== null) {
      const problem = { ok: false, error: 'invalid_field', field: badField };
      if (fields.badLocation !== undefined) {
        problem.location = fields.badLocation;
      }
      if (fields.badTier !== undefined) {
        problem.tier = fields.badTier;
      }
      if (fields.badMeal !== undefined) {
        problem.meal = fields.badMeal;
      }
      if (fields.badRoom !== undefined) {
        problem.room = fields.badRoom;
      }
      if (fields.badItem !== undefined) {
        problem.item = fields.badItem;
      }
      if (fields.badContact !== undefined) {
        problem.contact = fields.badContact;
      }
      if (fields.badRegistration !== undefined) {
        problem.registration = fields.badRegistration;
      }
      return problem;
    }
  }
  return { ok: true, fields };
}

// ---------------------------------------------------------------------------
// Registration (migrations/024): who can still change their answers, the
// donation added to a ticket, and upgrading to a dearer tier.
// ---------------------------------------------------------------------------

// Whether someone going can still change their registration answers or
// upgrade: the event is not cancelled or over, RSVPs are open, and none of
// the tiers they hold has closed. stored: their attendee row (null for
// someone not going yet, who is held only to the event).
export function registrationOpenFor(row, stored = null, now = Date.now()) {
  if (!row || row.status === 'cancelled' || isOver(row, now) || row.rsvp_open === false) {
    return false;
  }
  return !heldTiers(row, stored).some((tier) => tierClosed(tier, now));
}

// The donation in someone's registration answers (0 for none), at a paid
// event whose form asks for one.
export function donationOf(row, registration) {
  if (!row || row.price_type !== 'paid' || !registration || typeof registration !== 'object') {
    return 0;
  }
  const amount = Number(registration.donation);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  return Math.round(amount * 100) / 100;
}

// What has been paid towards someone's ticket so far: all of it once it is
// confirmed paid, otherwise what was paid before their last upgrade.
export function paidSoFar(stored) {
  if (!stored) {
    return 0;
  }
  if (stored.payment_status === 'paid') {
    const amount = Number(stored.payment_amount);
    if (!Number.isFinite(amount)) {
      return 0;
    }
    return amount;
  }
  const credit = Number(stored.payment_credit);
  if (!Number.isFinite(credit) || credit < 0) {
    return 0;
  }
  return credit;
}

// The dearest tier in a basket that is held only once (the one an upgrade
// swaps), or null.
function upgradeFrom(basket) {
  let from = null;
  for (const item of basket) {
    if (item.quantity !== 1) {
      continue;
    }
    if (from === null || item.price > from.price) {
      from = item;
    }
  }
  return from;
}

// The basket someone holds, as basketPrice takes it: [{ tier, tierName,
// quantity }] by the event's current tier list, or null when a tier they
// bought has since gone.
function heldBasket(row, stored) {
  const tiers = storedTiers(row);
  if (!stored || !Array.isArray(stored.payment_items) || stored.payment_items.length === 0) {
    let tierText = null;
    if (stored) {
      tierText = stored.payment_tier;
    }
    const named = tierNamed(row, tierText);
    if (!named) {
      return null;
    }
    return [{ tier: tiers.indexOf(named), tierName: named.name, quantity: 1, id: named.id, price: named.price }];
  }
  const basket = [];
  for (const item of stored.payment_items.filter(isObject)) {
    const index = tiers.findIndex((tier) => tier.id === item.id);
    if (index < 0) {
      return null;
    }
    let quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      quantity = 1;
    }
    basket.push({ tier: index, tierName: tiers[index].name, quantity, id: tiers[index].id, price: tiers[index].price });
  }
  return basket;
}

// The tiers someone holding a ticket can upgrade to, and what each would
// cost: { from: the tier they would give up ({ name }), options: [{ index,
// name, price, total, due }] } (total: the new order's amount, with the
// volunteer benefit and their donation; due: total less what they have
// paid), or null when they cannot upgrade at all. An upgrade swaps the
// dearest tier they hold one of for a dearer one they do not hold, that
// is still sold, and that can be paid for with the rest of their tiers.
// Not while a payment they reported waits to be checked.
export function upgradeOptions(row, stored, { volunteerDiscount = false, now = Date.now() } = {}) {
  if (!stored || !stored.payment_method || !sellsTiers(row) || !registrationOpenFor(row, stored, now)) {
    return null;
  }
  if (stored.payment_status === 'submitted') {
    return null;
  }
  const basket = heldBasket(row, stored);
  if (!basket) {
    return null;
  }
  const from = upgradeFrom(basket);
  if (!from) {
    return null;
  }
  const heldIds = basket.map((item) => item.id);
  const options = [];
  storedTiers(row).forEach((tier, index) => {
    if (heldIds.includes(tier.id) || tier.price <= from.price || tierClosed(tier, now)) {
      return;
    }
    const priced = upgradeBasket(row, stored, index, tier.name, { volunteerDiscount, now });
    if (!priced.ok) {
      return;
    }
    options.push({ index, name: tier.name, price: tier.price, total: priced.amount, due: priced.due });
  });
  return { from: { name: from.tierName }, options };
}

// The order after an upgrade to tier index (named tierName, so a list that
// changed meanwhile is caught): { ok: true, items, text, tiers, amount,
// due, methods } or { ok: false, error }.
export function upgradeBasket(row, stored, index, tierName, { volunteerDiscount = false, now = Date.now() } = {}) {
  const basket = heldBasket(row, stored);
  if (!basket) {
    return { ok: false, error: 'upgrade_unavailable' };
  }
  const from = upgradeFrom(basket);
  if (!from) {
    return { ok: false, error: 'upgrade_unavailable' };
  }
  const tiers = storedTiers(row);
  const target = tiers[index];
  if (!Number.isInteger(index) || !target || target.name !== tierName) {
    return { ok: false, error: 'tier_changed' };
  }
  if (target.price <= from.price || basket.some((item) => item.id === target.id)) {
    return { ok: false, error: 'upgrade_unavailable' };
  }
  const items = basket
    .filter((item) => item !== from)
    .map((item) => ({ tier: item.tier, tierName: item.tierName, quantity: item.quantity }));
  items.push({ tier: index, tierName, quantity: 1 });
  const priced = basketPrice(row, items, { volunteerDiscount, now, allowClosed: basket.map((item) => item.id) });
  if (!priced.ok) {
    return priced;
  }
  const methods = basketOptions(row, priced.tiers);
  if (methods.length === 0) {
    return { ok: false, error: 'tiers_not_together' };
  }
  const amount = Math.round((priced.amount + donationOf(row, stored.registration)) * 100) / 100;
  const due = Math.max(0, Math.round((amount - paidSoFar(stored)) * 100) / 100);
  return { ok: true, items: priced.items, text: priced.text, tiers: priced.tiers, amount, due, methods };
}
