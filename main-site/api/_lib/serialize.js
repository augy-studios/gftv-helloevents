// What leaves the server, decided field by field (server-side data
// minimisation, help desk #7).
//
// No route sends a database row as it came back: every response body is built
// here from an explicit list of fields for that caller, so a column added to
// a table later is never published by accident. In particular:
//
//   Unreleased events (drafts, or published with a release time still in the
//   future) are never serialised for the public at all; the public queries
//   filter them out in the database (event-rules.js releasedFilter).
//   Dates marked "to be announced" go out as { tba: true }, without the
//   stored start and end.
//   A hidden price goes out as { type: "tba" }, without the stored amounts.
//   An address marked attendees-only, and the online link, go only to people
//   who are going, and to editors.
//   Staff notes, who created or edited an event, and attendee identities go
//   only to editors, and an attendee is a display name and username, never
//   an email.
//   Password hashes, TOTP secrets, code and token hashes, Telegram chat ids,
//   emails, notification choices of other people and IP hashes have no
//   serializer at all, so they cannot reach a browser. Public accounts are
//   held to exactly the same lists as staff ones.
//
// And each answer carries only what the page that asks for it shows, plus
// the ids its buttons send back (help desk #18): nothing a page never reads,
// even about the person themselves. tests/response-keys.test.js pins every
// answer's exact keys.
//
// Each answer field is written next to the database column it comes from,
// as `answerField: row.database_column`, through one of the small helpers
// below when the column needs a default.

import { isOver, datesAnnounced, utcToWall } from './event-rules.js';
import { roleOf, canManage } from './users.js';
import { coverUrl } from './covers.js';

// ---------------------------------------------------------------------------
// Defaults
//
// "Empty" means any false-like value: null, undefined, '', 0, false or NaN.
// "Missing" means null or undefined only, so a 0 or '' is kept as it is.
// ---------------------------------------------------------------------------

// The value, or null when it is empty.
function emptyToNull(value) {
  if (value) {
    return value;
  }
  return null;
}

// The value, or '' when it is empty: a blank form field.
function emptyToBlank(value) {
  if (value) {
    return value;
  }
  return '';
}

// The value, or null when it is missing.
function missingToNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return value;
}

// The value as a number, or null when it is missing.
function numberOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

// The value as a string, or '' when it is missing: a form field.
function stringOrBlank(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// The value as a number, or 0 when that is not a number.
function numberOrZero(value) {
  const number = Number(value);
  if (number) {
    return number;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// The signed-in person, about themselves. Their own notification choices are
// theirs to see; the email is not sent even to them (nothing here needs it).
export function selfView(user) {
  let displayName = user.display_name;
  if (!displayName) {
    displayName = user.username;
  }
  // Only an https:// address goes out; any other stored value is dropped.
  let avatarUrl = null;
  if (typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://')) {
    avatarUrl = user.avatar_url;
  }
  let kind = 'staff';
  if (user.kind === 'public') {
    kind = 'public';
  }
  return {
    username: user.username,
    displayName,
    avatarUrl,
    kind,
    role: roleOf(user),
    canManage: canManage(user),
  };
}

// An attendee, for an editor's attendee list: a name, a username and
// whether it is a staff or a public account. Never an email or an id.
// row: { created_at, account: { kind, username, display_name, staff: {...} } }
export function attendeeView(row) {
  let account = row.account;
  if (account === null || account === undefined) {
    account = {};
  }
  const isStaff = account.kind === 'staff';
  // A staff account's names are on its gftvhello_users record.
  let person = account;
  if (isStaff) {
    person = account.staff;
    if (person === null || person === undefined) {
      person = {};
    }
  }
  let displayName = person.display_name;
  if (!displayName) {
    displayName = person.username;
  }
  if (!displayName) {
    displayName = null;
  }
  return {
    username: missingToNull(person.username),
    displayName,
    staff: isStaff,
    rsvpAt: row.created_at,
  };
}

// A passkey on the account page: its name, when it was added and when it was
// last used ("Never used" while lastUsedAt is null), and the id the Remove
// button sends.
export function passkeyView(row) {
  return {
    id: row.id,
    label: emptyToNull(row.label),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// The price. A card shows only the price itself; the event page also shows
// the organiser's note under it, so only the page asks for it (withNote).
function priceView(row, { withNote = false } = {}) {
  if (row.price_hidden || row.price_type === 'tba') {
    return { type: 'tba' };
  }
  let view;
  if (row.price_type === 'free') {
    view = { type: 'free' };
  } else {
    view = {
      type: 'paid',
      min: numberOrNull(row.price_min),
      max: numberOrNull(row.price_max),
      currency: emptyToNull(row.currency),
    };
  }
  if (withNote) {
    view.note = emptyToNull(row.price_note);
  }
  return view;
}

function whenView(row) {
  if (!datesAnnounced(row)) {
    return { tba: true, timezone: row.timezone };
  }
  return { tba: false, startsAt: row.starts_at, endsAt: emptyToNull(row.ends_at), timezone: row.timezone };
}

// The count of people going, from an embedded aggregate
// (gftvevents_attendees(count)) or a number.
export function goingCount(row) {
  const embedded = row.gftvevents_attendees;
  if (Array.isArray(embedded)) {
    const aggregate = embedded[0];
    let count;
    if (aggregate !== null && aggregate !== undefined) {
      count = aggregate.count;
    }
    return numberOrZero(count);
  }
  return numberOrZero(row.going_count);
}

// The capacity and the spaces left, both null when there is no limit.
function spacesView(row, going) {
  if (!row.capacity) {
    return { capacity: null, left: null };
  }
  return { capacity: row.capacity, left: Math.max(0, row.capacity - going) };
}

function rsvpState(row, going, now) {
  if (row.status === 'cancelled') {
    return 'cancelled';
  }
  if (isOver(row, now)) {
    return 'over';
  }
  if (!row.rsvp_open) {
    return 'closed';
  }
  if (row.capacity && going >= row.capacity) {
    return 'full';
  }
  return 'open';
}

// A card in the public feed (and in "Events you are going to" on the account
// page). Only call this for a released event. A card shows no spaces left
// and no price note; the event page adds those.
export function publicEventCard(row, now = Date.now()) {
  const going = goingCount(row);
  return {
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    summary: emptyToNull(row.summary),
    coverImageUrl: coverUrl(row.cover_image_path),
    cancelled: row.status === 'cancelled',
    when: whenView(row),
    where: {
      online: row.is_online === true,
      venueName: emptyToNull(row.venue_name),
      city: emptyToNull(row.city),
      country: emptyToNull(row.country),
    },
    price: priceView(row),
    going,
    rsvp: rsvpState(row, going, now),
  };
}

// The event page. viewer: { signedIn, going, canManage }. Only call this for
// a released event, or for an editor.
//
// It is the card plus the price note, the spaces left, the description, the
// organiser and the link. People going and editors ("insiders") also get an
// attendees-only address and the online link; everyone else gets only a flag
// saying there is one for attendees.
export function publicEventDetail(row, viewer = {}, now = Date.now()) {
  const card = publicEventCard(row, now);
  let insider = false;
  if (viewer.going === true || viewer.canManage === true) {
    insider = true;
  }
  let addressShown = false;
  if (!row.address_attendees_only || insider) {
    addressShown = true;
  }

  let address = null;
  if (addressShown) {
    address = emptyToNull(row.venue_address);
  }
  let addressForAttendees = false;
  if (row.address_attendees_only && row.venue_address && !addressShown) {
    addressForAttendees = true;
  }
  let onlineUrl = null;
  if (insider && row.is_online) {
    onlineUrl = emptyToNull(row.online_url);
  }
  let onlineUrlForAttendees = false;
  if (row.is_online && row.online_url && !insider) {
    onlineUrlForAttendees = true;
  }

  return {
    ...card,
    price: priceView(row, { withNote: true }),
    ...spacesView(row, card.going),
    description: emptyToNull(row.description),
    organiserName: emptyToNull(row.organiser_name),
    externalUrl: emptyToNull(row.external_url),
    where: {
      ...card.where,
      address,
      addressForAttendees,
      onlineUrl,
      onlineUrlForAttendees,
    },
    viewer: {
      signedIn: viewer.signedIn === true,
      going: viewer.going === true,
      canManage: viewer.canManage === true,
    },
  };
}

// One of my RSVPs, for the account page: the event's card. The page shows
// no RSVP date, so none is sent.
export function myRsvpView(row, now = Date.now()) {
  const event = row.event;
  let card = null;
  if (event) {
    card = publicEventCard(event, now);
  }
  return { event: card };
}

// An editor's list row: what the list on /manage shows (title, status, kind,
// date or "to be announced", people going) and the id and slug its Edit
// button and ?slug= link use.
export function managedSummary(row, now = Date.now()) {
  // Released: not a draft, and either no release time or one already past.
  let released = false;
  if (row.status !== 'draft' && (!row.publish_at || new Date(row.publish_at).getTime() <= now)) {
    released = true;
  }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    released,
    startsAt: emptyToNull(row.starts_at),
    datesHidden: row.dates_hidden === true,
    going: goingCount(row),
    capacity: missingToNull(row.capacity),
  };
}

// The cover picture alone, for the answer to an upload or removal
// (api/manage/cover.js): the edit form redraws only its cover preview.
export function managedCover(row) {
  return {
    coverImageUrl: emptyToBlank(coverUrl(row.cover_image_path)),
    hasCover: Boolean(row.cover_image_path),
  };
}

// Everything an editor can change, in the shape the edit form sends back,
// plus the id and slug the form's buttons use. Nothing the form does not
// fill in: no counts, no "released" flag, no stored timestamps. An empty
// text column comes back as '', so the form shows a blank field.
export function managedEvent(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    datesHidden: row.dates_hidden === true,
    timezone: row.timezone,
    capacity: missingToNull(row.capacity),
    summary: emptyToBlank(row.summary),
    description: emptyToBlank(row.description),
    startsLocal: utcToWall(row.starts_at, row.timezone),
    endsLocal: utcToWall(row.ends_at, row.timezone),
    publishLocal: utcToWall(row.publish_at, row.timezone),
    isOnline: row.is_online === true,
    onlineUrl: emptyToBlank(row.online_url),
    venueName: emptyToBlank(row.venue_name),
    venueAddress: emptyToBlank(row.venue_address),
    addressAttendeesOnly: row.address_attendees_only === true,
    city: emptyToBlank(row.city),
    country: emptyToBlank(row.country),
    ...managedCover(row),
    externalUrl: emptyToBlank(row.external_url),
    organiserName: emptyToBlank(row.organiser_name),
    priceType: row.price_type,
    priceHidden: row.price_hidden === true,
    priceMin: stringOrBlank(row.price_min),
    priceMax: stringOrBlank(row.price_max),
    currency: emptyToBlank(row.currency),
    priceNote: emptyToBlank(row.price_note),
    rsvpOpen: row.rsvp_open !== false,
    staffNotes: emptyToBlank(row.staff_notes),
  };
}
