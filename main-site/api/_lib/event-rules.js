// Events: what an editor may save, when an event is public, and converting
// wall-clock times in an event's own time zone to and from UTC.
//
// Pure functions, no database, so tests/unit.test.js can run them directly.

export const KINDS = ['furmeet', 'convention', 'other'];
export const STATUSES = ['draft', 'published', 'cancelled'];
export const PRICE_TYPES = ['free', 'paid', 'tba'];
export const DEFAULT_TIMEZONE = 'Asia/Singapore';

export const LIMITS = Object.freeze({
  title: 120,
  summary: 280,
  description: 8000,
  venueName: 160,
  venueAddress: 300,
  city: 80,
  country: 80,
  organiserName: 120,
  priceNote: 200,
  staffNotes: 4000,
  url: 500,
  label: 60,
});

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A wall-clock time as the edit form sends it: "2026-11-14T14:00".
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

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
export function releasedFilter(query, nowIso = new Date().toISOString()) {
  // The timestamp is quoted because it contains PostgREST's reserved "." and
  // ":" characters. It is always a Date#toISOString(), never user input.
  return query.in('status', ['published', 'cancelled']).or(`publish_at.is.null,publish_at.lte."${nowIso}"`);
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

// The free-text fields: [form field, column, longest allowed].
const TEXT_FIELDS = [
  ['summary', 'summary', LIMITS.summary],
  ['description', 'description', LIMITS.description],
  ['venueName', 'venue_name', LIMITS.venueName],
  ['venueAddress', 'venue_address', LIMITS.venueAddress],
  ['city', 'city', LIMITS.city],
  ['country', 'country', LIMITS.country],
  ['organiserName', 'organiser_name', LIMITS.organiserName],
  ['priceNote', 'price_note', LIMITS.priceNote],
  ['staffNotes', 'staff_notes', LIMITS.staffNotes],
];

// Each free-text field, length-checked. A blank one is stored as null.
function readTextFields(body, fields) {
  for (const [formField, column, maximumLength] of TEXT_FIELDS) {
    const value = cleanText(body[formField], maximumLength);
    if (value.length > maximumLength) {
      return formField;
    }
    if (value === '') {
      fields[column] = null;
    } else {
      fields[column] = value;
    }
  }
  return null;
}

// The wall-clock times on the form, and the UTC columns they are stored in.
const TIME_FIELDS = [
  ['startsLocal', 'starts_at'],
  ['endsLocal', 'ends_at'],
  ['publishLocal', 'publish_at'],
];

// The time zone, then each time on the form converted from it to UTC (blank
// is null). An event needs a start unless its dates are hidden, cannot end
// without a start, and cannot end before it starts.
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
  for (const [formField, column] of TIME_FIELDS) {
    const wallTime = cleanText(body[formField], 16);
    if (wallTime === '') {
      fields[column] = null;
    } else {
      const utcTime = wallToUtc(wallTime, fields.timezone);
      if (!utcTime) {
        return formField;
      }
      fields[column] = utcTime;
    }
  }

  if (!fields.starts_at && !fields.dates_hidden) {
    return 'startsLocal';
  }
  if (fields.ends_at && !fields.starts_at) {
    return 'startsLocal';
  }
  if (fields.ends_at && fields.starts_at && new Date(fields.ends_at) < new Date(fields.starts_at)) {
    return 'endsLocal';
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

// The price type, then the amounts and currency, which are kept only for a
// paid event. A paid event needs a minimum, the maximum cannot be below the
// minimum, and the currency defaults to SGD.
function readPrice(body, fields) {
  fields.price_type = allowedOrNull(PRICE_TYPES, body.priceType);
  if (!fields.price_type) {
    return 'priceType';
  }
  fields.price_hidden = body.priceHidden === true;

  const minimumPrice = parseMoney(body.priceMin);
  if (!minimumPrice.ok) {
    return 'priceMin';
  }
  const maximumPrice = parseMoney(body.priceMax);
  if (!maximumPrice.ok) {
    return 'priceMax';
  }
  const isPaid = fields.price_type === 'paid';
  if (isPaid) {
    fields.price_min = minimumPrice.value;
    fields.price_max = maximumPrice.value;
  } else {
    fields.price_min = null;
    fields.price_max = null;
  }
  if (isPaid && fields.price_min === null) {
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
  return null;
}

// The steps, in order. The order decides which field is reported when more
// than one is wrong, and later steps read columns earlier ones wrote (the
// times need the time zone).
const VALIDATION_STEPS = [readIdentity, readTextFields, readTimes, readPlaceAndLinks, readPrice, readCapacity];

// { ok: true, fields } with the columns to write, or
// { ok: false, error: 'invalid_field', field } naming the first form field
// that is wrong.
export function validateEvent(input) {
  let body = {};
  if (input && typeof input === 'object') {
    body = input;
  }
  const fields = {};
  for (const step of VALIDATION_STEPS) {
    const badField = step(body, fields);
    if (badField !== null) {
      return { ok: false, error: 'invalid_field', field: badField };
    }
  }
  return { ok: true, fields };
}
