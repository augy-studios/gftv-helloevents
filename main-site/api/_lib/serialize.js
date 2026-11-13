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

import { isOver, datesAnnounced, utcToWall } from './event-rules.js';
import { roleOf, canManage } from './users.js';
import { coverUrl } from './covers.js';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// The signed-in person, about themselves. Their own notification choices are
// theirs to see; the email is not sent even to them (nothing here needs it).
export function selfView(user) {
  return {
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://') ? user.avatar_url : null,
    kind: user.kind === 'public' ? 'public' : 'staff',
    role: roleOf(user),
    canManage: canManage(user),
  };
}

// An attendee, for an editor's attendee list: a name, a username and
// whether it is a staff or a public account. Never an email or an id.
// row: { created_at, account: { kind, username, display_name, staff: {...} } }
export function attendeeView(row) {
  const account = row.account ?? {};
  const person = account.kind === 'staff' ? account.staff ?? {} : account;
  return {
    username: person.username ?? null,
    displayName: person.display_name || person.username || null,
    staff: account.kind === 'staff',
    rsvpAt: row.created_at,
  };
}

// A passkey on the account page: its name, when it was added and when it was
// last used ("Never used" while lastUsedAt is null), and the id the Remove
// button sends.
export function passkeyView(row) {
  return { id: row.id, label: row.label || null, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// The price. A card shows only the price itself; the event page also shows
// the organiser's note under it, so only the page asks for it (withNote).
function priceView(row, { withNote = false } = {}) {
  if (row.price_hidden || row.price_type === 'tba') return { type: 'tba' };
  let view;
  if (row.price_type === 'free') {
    view = { type: 'free' };
  } else {
    view = {
      type: 'paid',
      min: row.price_min === null || row.price_min === undefined ? null : Number(row.price_min),
      max: row.price_max === null || row.price_max === undefined ? null : Number(row.price_max),
      currency: row.currency || null,
    };
  }
  if (withNote) {
    view.note = row.price_note || null;
  }
  return view;
}

function whenView(row) {
  if (!datesAnnounced(row)) return { tba: true, timezone: row.timezone };
  return { tba: false, startsAt: row.starts_at, endsAt: row.ends_at || null, timezone: row.timezone };
}

// The count of people going, from an embedded aggregate
// (gftvevents_attendees(count)) or a number.
export function goingCount(row) {
  const embedded = row.gftvevents_attendees;
  if (Array.isArray(embedded)) return Number(embedded[0]?.count) || 0;
  return Number(row.going_count) || 0;
}

function spaces(row, going) {
  if (!row.capacity) return { capacity: null, left: null };
  return { capacity: row.capacity, left: Math.max(0, row.capacity - going) };
}

function rsvpState(row, going, now) {
  if (row.status === 'cancelled') return 'cancelled';
  if (isOver(row, now)) return 'over';
  if (!row.rsvp_open) return 'closed';
  if (row.capacity && going >= row.capacity) return 'full';
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
    summary: row.summary || null,
    coverImageUrl: coverUrl(row.cover_image_path),
    cancelled: row.status === 'cancelled',
    when: whenView(row),
    where: {
      online: row.is_online === true,
      venueName: row.venue_name || null,
      city: row.city || null,
      country: row.country || null,
    },
    price: priceView(row),
    going,
    rsvp: rsvpState(row, going, now),
  };
}

// The event page. viewer: { signedIn, going, canManage }. Only call this for
// a released event, or for an editor.
export function publicEventDetail(row, viewer = {}, now = Date.now()) {
  const card = publicEventCard(row, now);
  const insider = viewer.going === true || viewer.canManage === true;
  const addressShown = !row.address_attendees_only || insider;
  return {
    ...card,
    price: priceView(row, { withNote: true }),
    ...spaces(row, card.going),
    description: row.description || null,
    organiserName: row.organiser_name || null,
    externalUrl: row.external_url || null,
    where: {
      ...card.where,
      address: addressShown ? row.venue_address || null : null,
      addressForAttendees: Boolean(row.address_attendees_only && row.venue_address && !addressShown),
      onlineUrl: insider && row.is_online ? row.online_url || null : null,
      onlineUrlForAttendees: Boolean(row.is_online && row.online_url && !insider),
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
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    released: row.status !== 'draft' && (!row.publish_at || new Date(row.publish_at).getTime() <= now),
    startsAt: row.starts_at || null,
    datesHidden: row.dates_hidden === true,
    going: goingCount(row),
    capacity: row.capacity ?? null,
  };
}

// The cover picture alone, for the answer to an upload or removal
// (api/manage/cover.js): the edit form redraws only its cover preview.
export function managedCover(row) {
  return {
    coverImageUrl: coverUrl(row.cover_image_path) || '',
    hasCover: Boolean(row.cover_image_path),
  };
}

// Everything an editor can change, in the shape the edit form sends back,
// plus the id and slug the form's buttons use. Nothing the form does not
// fill in: no counts, no "released" flag, no stored timestamps.
export function managedEvent(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    datesHidden: row.dates_hidden === true,
    timezone: row.timezone,
    capacity: row.capacity ?? null,
    summary: row.summary || '',
    description: row.description || '',
    startsLocal: utcToWall(row.starts_at, row.timezone),
    endsLocal: utcToWall(row.ends_at, row.timezone),
    publishLocal: utcToWall(row.publish_at, row.timezone),
    isOnline: row.is_online === true,
    onlineUrl: row.online_url || '',
    venueName: row.venue_name || '',
    venueAddress: row.venue_address || '',
    addressAttendeesOnly: row.address_attendees_only === true,
    city: row.city || '',
    country: row.country || '',
    ...managedCover(row),
    externalUrl: row.external_url || '',
    organiserName: row.organiser_name || '',
    priceType: row.price_type,
    priceHidden: row.price_hidden === true,
    priceMin: row.price_min === null || row.price_min === undefined ? '' : String(row.price_min),
    priceMax: row.price_max === null || row.price_max === undefined ? '' : String(row.price_max),
    currency: row.currency || '',
    priceNote: row.price_note || '',
    rsvpOpen: row.rsvp_open !== false,
    staffNotes: row.staff_notes || '',
  };
}
