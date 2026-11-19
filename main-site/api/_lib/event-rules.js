// Events: what an editor may save, when an event is public, and converting
// wall-clock times in an event's own time zone to and from UTC.
//
// Pure functions, no database, so tests/unit.test.js can run them directly.

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
// Ticket tiers on a paid event (migrations/008): at most MAX_TIERS, each with
// at most MAX_TIER_BENEFITS benefits. A tier that includes the one before it
// shows those benefits again in full, or names the tier ("reference").
export const MAX_TIERS = 10;
export const MAX_TIER_BENEFITS = 20;
export const PREVIOUS_DISPLAYS = ['full', 'reference'];

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
  mealLabel: 40,
  tierName: 60,
  tierBenefit: 200,
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

// The free-text fields: [form field, column, longest allowed]. The place
// fields are per location (readLocations).
const TEXT_FIELDS = [
  ['summary', 'summary', LIMITS.summary],
  ['description', 'description', LIMITS.description],
  ['descriptionZh', 'description_zh', LIMITS.description],
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

// Each free-text field, length-checked; then both descriptions, which may
// not be blank.
function readTextFields(body, fields) {
  for (const [formField, column, maximumLength] of TEXT_FIELDS) {
    if (!putText(fields, column, body[formField], maximumLength).ok) {
      return formField;
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
// { ok: false, field }.
function readLocation(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, field: 'locations' };
  }
  const location = { label: allowedOrNull(LOCATION_LABELS, entry.label) };
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
  return locations.map((location) => {
    const tidy = {};
    for (const key of LOCATION_KEYS) {
      tidy[key] = null;
      if (location[key] !== undefined && location[key] !== null && location[key] !== '') {
        tidy[key] = location[key];
      }
    }
    return tidy;
  });
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
  return null;
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
// limit } (label null for breakfast, lunch and dinner; limit null for no
// limit), skipping anything malformed.
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
    if (BUILT_IN_MEALS.includes(meal.id)) {
      meals.push({ id: meal.id, label: null, limit });
    } else if (typeof meal.label === 'string' && meal.label !== '') {
      meals.push({ id: meal.id, label: meal.label, limit });
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

// The meals people can come to on their own: [{ id, label, limit }] from
// the form, breakfast, lunch and dinner by id (and limit), a named meal with
// its id and name. A limit is how many can come for that meal alone (blank:
// no limit); people coming to the whole event do not count against it. They are stored with the three first, in that order, then the named
// ones as given. A named meal left blank is dropped, like an untouched
// location. With no meals field at all the stored ones are kept, so a page
// from before meal-only RSVPs cannot wipe what another editor set.
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
    if (BUILT_IN_MEALS.includes(id)) {
      ticked.set(id, limit.limit);
      continue;
    }
    const label = cleanText(entry.label, LIMITS.mealLabel);
    if (label.length > LIMITS.mealLabel) {
      return 'mealLabel';
    }
    if (label !== '') {
      named.push({ id, label, limit: limit.limit });
    }
  }
  if (named.length > MAX_CUSTOM_MEALS) {
    return 'meals';
  }
  fields.meal_options = [
    ...BUILT_IN_MEALS.filter((id) => ticked.has(id)).map((id) => ({ id, label: null, limit: ticked.get(id) })),
    ...named,
  ];
  return null;
}

// One ticket tier from the form: { name, price, benefits (one per line),
// includesPrevious, previousDisplay }, as { ok: true, tier } (tier null when
// it is left wholly blank, so an untouched card is dropped) or
// { ok: false, field }. A tier needs a name and a price (0 for a free tier).
function readTier(entry) {
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
  let previousDisplay = allowedOrNull(PREVIOUS_DISPLAYS, entry.previousDisplay);
  if (!previousDisplay) {
    previousDisplay = 'reference';
  }
  return {
    ok: true,
    tier: { name, price: price.value, benefits, includes_previous: entry.includesPrevious === true, previous_display: previousDisplay },
  };
}

// Ticket tiers (migrations/008): the list, each checked, and whether they are
// on. They are on only for a paid event, and then there must be at least
// and the cheapest and dearest prices become the price range the feed cards
// show. The first tier has no tier before it to include. With no
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
    const check = readTier(entry);
    if (!check.ok) {
      fields.badTier = index;
      return check.field;
    }
    if (check.tier) {
      tiers.push(check.tier);
    }
  }
  if (tiers.length) {
    tiers[0].includes_previous = false;
  }
  fields.ticket_tiers = tiers;
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
    tiers.push({
      name: tier.name,
      price,
      benefits,
      includes_previous: tier.includes_previous === true,
      previous_display: previousDisplay,
    });
  }
  // The first tier has no tier before it to include.
  if (tiers.length) {
    tiers[0].includes_previous = false;
  }
  return tiers;
}

// The steps, in order. The order decides which field is reported when more
// than one is wrong, and later steps read columns earlier ones wrote (the
// times need the time zone).
const VALIDATION_STEPS = [readIdentity, readTextFields, readTimes, readLocations, readPlaceAndLinks, readPrice, readTiers, readCapacity, readMeals];

// { ok: true, fields } with the columns to write, or
// { ok: false, error: 'invalid_field', field } naming the first form field
// that is wrong, plus location (its place in the list, from 0) when that
// field is one location's, or tier when it is one ticket tier's.
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
      return problem;
    }
  }
  return { ok: true, fields };
}
