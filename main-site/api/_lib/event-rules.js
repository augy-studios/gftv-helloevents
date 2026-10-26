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
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// ---------------------------------------------------------------------------
// Visibility. The one rule for "can the public see this event": published or
// cancelled, and past its release time. Drafts, and published events whose
// release time has not come, are unreleased: they are never sent to anyone
// but editors, and the public routes answer 404 for them, not 403, so their
// existence is not given away either.
// ---------------------------------------------------------------------------

export function isReleased(row, now = Date.now()) {
  if (!row) return false;
  if (row.status !== 'published' && row.status !== 'cancelled') return false;
  if (row.publish_at && new Date(row.publish_at).getTime() > now) return false;
  return true;
}

// The same rule as a PostgREST filter, applied in the query so unreleased
// rows never leave the database for a public request.
export function releasedFilter(query, nowIso = new Date().toISOString()) {
  // The timestamp is quoted because it contains PostgREST's reserved "." and
  // ":" characters. It is always a Date#toISOString(), never user input.
  return query.in('status', ['published', 'cancelled']).or(`publish_at.is.null,publish_at.lte."${nowIso}"`);
}

export function isOver(row, now = Date.now()) {
  const last = row.ends_at || row.starts_at;
  return Boolean(last) && new Date(last).getTime() < now;
}

export function datesAnnounced(row) {
  return !row.dates_hidden && Boolean(row.starts_at);
}

// ---------------------------------------------------------------------------
// Time zones. Editors type a wall-clock time ("2026-11-14T14:00") in the
// event's own zone; the database keeps UTC. No library: Intl does it.
// ---------------------------------------------------------------------------

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Milliseconds the zone is ahead of UTC at the instant `ms`.
function zoneOffset(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "2026-11-14T14:00" in tz -> ISO string in UTC, or null if malformed.
export function wallToUtc(wall, tz) {
  const m = WALL.exec(String(wall ?? ''));
  if (!m || !isTimeZone(tz)) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset, including across a daylight saving change.
  let utc = guess - zoneOffset(guess, tz);
  utc = guess - zoneOffset(utc, tz);
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ISO string in UTC -> "2026-11-14T14:00" in tz, for the edit form.
export function utcToWall(iso, tz) {
  if (!iso || !isTimeZone(tz)) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const local = new Date(ms + zoneOffset(ms, tz));
  return local.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Validation. The editor form sends camelCase fields; this returns the
// snake_case columns to write, or the first problem as { error, field }.
// Unknown fields are ignored, so nothing the browser invents reaches the
// table. Text is trimmed and length-checked; addresses must be https.
// ---------------------------------------------------------------------------

function text(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max + 1);
}

export function httpsUrl(value) {
  const raw = text(value, LIMITS.url);
  if (raw === '') return { ok: true, url: null };
  if (raw.length > LIMITS.url) return { ok: false };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return { ok: false };
  return { ok: true, url: url.href };
}

export function slugify(title) {
  const base = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `event-${base || 'new'}`.slice(0, 50);
}

export function isSlug(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 60 && SLUG.test(value);
}

function money(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99_999_999) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function validateEvent(input) {
  const body = input && typeof input === 'object' ? input : {};
  const bad = (field) => ({ ok: false, error: 'invalid_field', field });
  const out = {};

  out.title = text(body.title, LIMITS.title);
  if (out.title === '' || out.title.length > LIMITS.title) return bad('title');

  const slug = text(body.slug, 60).toLowerCase();
  out.slug = slug === '' ? slugify(out.title) : slug;
  if (!isSlug(out.slug)) return bad('slug');

  out.kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!out.kind) return bad('kind');
  out.status = STATUSES.includes(body.status) ? body.status : null;
  if (!out.status) return bad('status');

  for (const [key, column, max] of [
    ['summary', 'summary', LIMITS.summary],
    ['description', 'description', LIMITS.description],
    ['venueName', 'venue_name', LIMITS.venueName],
    ['venueAddress', 'venue_address', LIMITS.venueAddress],
    ['city', 'city', LIMITS.city],
    ['country', 'country', LIMITS.country],
    ['organiserName', 'organiser_name', LIMITS.organiserName],
    ['priceNote', 'price_note', LIMITS.priceNote],
    ['staffNotes', 'staff_notes', LIMITS.staffNotes],
  ]) {
    const value = text(body[key], max);
    if (value.length > max) return bad(key);
    out[column] = value === '' ? null : value;
  }

  out.timezone = body.timezone === undefined || body.timezone === '' ? DEFAULT_TIMEZONE : body.timezone;
  if (!isTimeZone(out.timezone)) return bad('timezone');

  out.dates_hidden = body.datesHidden === true;
  for (const [key, column] of [['startsLocal', 'starts_at'], ['endsLocal', 'ends_at'], ['publishLocal', 'publish_at']]) {
    const raw = text(body[key], 16);
    if (raw === '') {
      out[column] = null;
      continue;
    }
    const iso = wallToUtc(raw, out.timezone);
    if (!iso) return bad(key);
    out[column] = iso;
  }
  if (!out.starts_at && !out.dates_hidden) return bad('startsLocal');
  if (out.ends_at && !out.starts_at) return bad('startsLocal');
  if (out.ends_at && out.starts_at && new Date(out.ends_at) < new Date(out.starts_at)) return bad('endsLocal');

  out.is_online = body.isOnline === true;
  out.address_attendees_only = body.addressAttendeesOnly === true;

  // The cover picture is not a field here: it is uploaded on its own to the
  // covers bucket (api/manage/cover.js, migrations/002).
  for (const [key, column] of [['externalUrl', 'external_url'], ['onlineUrl', 'online_url']]) {
    const check = httpsUrl(body[key]);
    if (!check.ok) return bad(key);
    out[column] = check.url;
  }

  out.price_type = PRICE_TYPES.includes(body.priceType) ? body.priceType : null;
  if (!out.price_type) return bad('priceType');
  out.price_hidden = body.priceHidden === true;
  const min = money(body.priceMin);
  if (!min.ok) return bad('priceMin');
  const max = money(body.priceMax);
  if (!max.ok) return bad('priceMax');
  out.price_min = out.price_type === 'paid' ? min.value : null;
  out.price_max = out.price_type === 'paid' ? max.value : null;
  if (out.price_type === 'paid' && out.price_min === null) return bad('priceMin');
  if (out.price_max !== null && out.price_min !== null && out.price_max < out.price_min) return bad('priceMax');
  const currency = text(body.currency, 3).toUpperCase();
  out.currency = out.price_type === 'paid' ? (currency || 'SGD') : null;
  if (out.currency && !/^[A-Z]{3}$/.test(out.currency)) return bad('currency');

  if (body.capacity === undefined || body.capacity === null || body.capacity === '') out.capacity = null;
  else {
    const n = Number(body.capacity);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return bad('capacity');
    out.capacity = n;
  }
  out.rsvp_open = body.rsvpOpen !== false;

  return { ok: true, fields: out };
}
