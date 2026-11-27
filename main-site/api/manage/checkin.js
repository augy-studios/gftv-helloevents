// The check-in page (/checkin?id=<event id>, migrations/027), for the
// event's editors: staff editors and admins, or an editor of this event
// (migrations/018), re-checked on every request.
//
// GET  ?id=                -> { event, attendees, counts }
//        attendees carry each person's code fingerprint (the SHA-256 of
//        their check-in code), so the page can recognise a scanned code with
//        no connection; it keeps the list on the device until the event is
//        over (js/pages/checkin.js)
// GET  ?id=&beacon=1       -> { beacon: { codes: [{ url, from, until }] } }
//        the self check-in QR code's addresses for the next few hours
//        (api/_lib/checkin.js), so the screen keeps changing offline; while
//        self check-in is on (else 409 self_checkin_off)
// POST { action: "checkin", id, code | query, idChecked? }
//        code: a scanned attendee code; query: an RSVP ID ("12", "#12") or a
//        username ("@name", "name"). When the event checks ID at the door,
//        idChecked: true says the organiser checked it (without it: 409
//        id_door_check_needed, with the person, so the page can ask)
//        -> { person, already, counts }
// POST { action: "undo", id, rsvpNumber } -> { person, counts }
// POST { action: "sync", id, entries: [{ rsvpNumber, at, how, idChecked,
//        undo }] } -> { results, counts }
//        what the page did while offline, in order: check-ins (at: when,
//        within the last day), door ID ticks and undos. A check-in someone
//        else made first stands.
// POST { action: "beacon", id, on }       -> { selfCheckin }
//
// person: what the door needs: name, username, RSVP ID, what they come
// for, their ticket and whether it is paid, where they stand with the
// event's ID check, the legal name and date of birth (only when the event
// checks ID, to hold against the card), and when and how they were checked
// in. Never an email or an id. A cancelled event takes no check-ins.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { PAYMENT_COLUMNS } from '../_lib/events.js';
import { sha256 } from '../_lib/crypto.js';
import { attendeeCode, readAttendeeCode, attendeeCodeMatches, beaconCodesAhead } from '../_lib/checkin.js';
import { eventIdProviders, idStanding } from '../_lib/id-checks.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_COLUMNS = 'id, slug, title, status, starts_at, ends_at, id_check_providers, id_check_door, self_checkin_on';
const ATTENDEE_COLUMNS =
  `user_id, rsvp_number, meals, lepak, checked_in_at, checked_in_how, id_door_checked_at, ${PAYMENT_COLUMNS}, ` +
  `account:${TABLES.accounts}!user_id ( kind, username, display_name, legal_name, date_of_birth, id_verified_providers, helloid_pending, staff:${TABLES.users} ( username, display_name ) )`;
const SYNC_LIMIT = 500;
const SYNC_MAX_AGE_MS = 24 * 3600_000;

function textOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return value;
}

async function loadEvent(eventId) {
  const { data, error } = await database().from(TABLES.events).select(EVENT_COLUMNS).eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The name and username an attendee row shows: a staff account's from
// gftv.asia, a public one's own.
function namesOf(row) {
  let account = row.account;
  if (!account) {
    account = {};
  }
  let person = account;
  if (account.kind === 'staff') {
    person = account.staff;
    if (!person) {
      person = {};
    }
  }
  let displayName = person.display_name;
  if (!displayName) {
    displayName = person.username;
  }
  return { account, username: textOrNull(person.username), displayName: textOrNull(displayName) };
}

function comingFor(row) {
  if (row.lepak === true) {
    return 'lepak';
  }
  if (Array.isArray(row.meals) && row.meals.length > 0) {
    return 'meals';
  }
  return 'event';
}

function checksId(event) {
  if (event.id_check_door === true) {
    return true;
  }
  return eventIdProviders(event).length > 0;
}

// One attendee, for the check-in page.
function personView(event, row) {
  const { account, username, displayName } = namesOf(row);
  let idCheck = null;
  if (eventIdProviders(event).length > 0) {
    idCheck = idStanding(event, account.id_verified_providers, account.helloid_pending === true);
  }
  let legalName = null;
  let dateOfBirth = null;
  if (checksId(event)) {
    legalName = textOrNull(account.legal_name);
    dateOfBirth = textOrNull(account.date_of_birth);
  }
  let paymentStatus = 'none';
  if (row.payment_status) {
    paymentStatus = row.payment_status;
  }
  return {
    rsvpNumber: textOrNull(row.rsvp_number),
    username,
    displayName,
    staff: account.kind === 'staff',
    comingFor: comingFor(row),
    ticket: textOrNull(row.payment_tier),
    paymentStatus,
    idCheck,
    legalName,
    dateOfBirth,
    idDoorCheckedAt: textOrNull(row.id_door_checked_at),
    checkedInAt: textOrNull(row.checked_in_at),
    checkedInHow: textOrNull(row.checked_in_how),
  };
}

// For the list the page keeps offline: the person, and their code's
// fingerprint.
function listedView(event, row) {
  const code = attendeeCode(event.id, row.user_id, row.rsvp_number);
  let fingerprint = null;
  if (code) {
    fingerprint = sha256(code);
  }
  return { ...personView(event, row), fingerprint };
}

async function attendeeRows(eventId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(ATTENDEE_COLUMNS)
    .eq('event_id', eventId)
    .order('rsvp_number', { ascending: true })
    .limit(5000);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data;
}

// The event as the page shows it, and until when it keeps the list (the
// end, or the start, plus a day).
function eventView(event) {
  let last = event.ends_at;
  if (!last) {
    last = event.starts_at;
  }
  let keepUntil = null;
  if (last) {
    keepUntil = new Date(new Date(last).getTime() + 24 * 3600_000).toISOString();
  }
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    cancelled: event.status === 'cancelled',
    selfCheckin: event.self_checkin_on === true,
    idCheck: eventIdProviders(event).length > 0,
    idDoor: event.id_check_door === true,
    keepUntil,
  };
}

function counts(rows) {
  return { going: rows.length, checkedIn: rows.filter((row) => row.checked_in_at).length };
}

// The attendee an organiser looked up: by a scanned code, an RSVP ID or a
// username. -> { row } or { error }.
function findPerson(rows, event, body) {
  if (typeof body.code === 'string' && body.code !== '') {
    const code = readAttendeeCode(body.code);
    if (!code) {
      return { error: 'checkin_code_invalid' };
    }
    if (code.eventId !== String(event.id).toLowerCase()) {
      return { error: 'checkin_other_event' };
    }
    const row = rows.find((each) => each.rsvp_number === code.rsvpNumber);
    if (!row || !attendeeCodeMatches(code, row.user_id)) {
      return { error: 'checkin_not_found' };
    }
    return { row };
  }
  let typed = '';
  if (typeof body.query === 'string') {
    typed = body.query.trim();
  }
  if (!typed || typed.length > 64) {
    return { error: 'checkin_not_found' };
  }
  const number = /^#?(\d{1,9})$/.exec(typed);
  if (number) {
    const row = rows.find((each) => each.rsvp_number === Number(number[1]));
    if (row) {
      return { row };
    }
    return { error: 'checkin_not_found' };
  }
  const username = typed.replace(/^@/, '').toLowerCase();
  const row = rows.find((each) => {
    const names = namesOf(each);
    if (names.username === null) {
      return false;
    }
    return names.username.toLowerCase() === username;
  });
  if (row) {
    return { row };
  }
  return { error: 'checkin_not_found' };
}

// Checks one attendee in (and ticks their door ID check). Returns whether
// they were already in. at: when (now, or when it happened offline).
async function markIn(event, row, user, how, idChecked, at) {
  if (idChecked && !row.id_door_checked_at) {
    const { error } = await database()
      .from(TABLES.attendees)
      .update({ id_door_checked_at: at, id_door_checked_by: user.id })
      .eq('event_id', event.id)
      .eq('user_id', row.user_id)
      .is('id_door_checked_at', null);
    if (error) {
      throw error;
    }
    row.id_door_checked_at = at;
  }
  if (row.checked_in_at) {
    return true;
  }
  const { data, error } = await database()
    .from(TABLES.attendees)
    .update({ checked_in_at: at, checked_in_by: user.id, checked_in_how: how })
    .eq('event_id', event.id)
    .eq('user_id', row.user_id)
    .is('checked_in_at', null)
    .select('checked_in_at');
  if (error) {
    throw error;
  }
  if (!Array.isArray(data) || data.length === 0) {
    return true;
  }
  row.checked_in_at = at;
  row.checked_in_how = how;
  return false;
}

async function checkIn(request, response, event, body, user) {
  if (event.status === 'cancelled') {
    return fail(response, 409, 'event_cancelled');
  }
  const rows = await attendeeRows(event.id);
  const found = findPerson(rows, event, body);
  if (found.error) {
    return fail(response, 404, found.error);
  }
  const row = found.row;
  const idChecked = body.idChecked === true;
  if (event.id_check_door === true && !row.id_door_checked_at && !idChecked && !row.checked_in_at) {
    return fail(response, 409, 'id_door_check_needed', { person: personView(event, row) });
  }
  let how = 'manual';
  if (typeof body.code === 'string' && body.code !== '') {
    how = 'scan';
  }
  const already = await markIn(event, row, user, how, idChecked, new Date().toISOString());
  if (!already) {
    await audit(request, { action: 'checkin.in', actorId: user.id, eventId: event.id, details: { rsvpNumber: row.rsvp_number, how, idChecked } });
  }
  return ok(response, { person: personView(event, row), already, counts: counts(rows) });
}

async function markOut(event, row) {
  const { error } = await database()
    .from(TABLES.attendees)
    .update({ checked_in_at: null, checked_in_by: null, checked_in_how: null, id_door_checked_at: null, id_door_checked_by: null })
    .eq('event_id', event.id)
    .eq('user_id', row.user_id);
  if (error) {
    throw error;
  }
  row.checked_in_at = null;
  row.checked_in_how = null;
  row.id_door_checked_at = null;
}

async function undo(request, response, event, body, user) {
  const rsvpNumber = Number(body.rsvpNumber);
  if (!Number.isInteger(rsvpNumber)) {
    return fail(response, 400, 'bad_request');
  }
  const rows = await attendeeRows(event.id);
  const row = rows.find((each) => each.rsvp_number === rsvpNumber);
  if (!row) {
    return fail(response, 404, 'checkin_not_found');
  }
  const wasIn = Boolean(row.checked_in_at);
  await markOut(event, row);
  if (wasIn) {
    await audit(request, { action: 'checkin.undone', actorId: user.id, eventId: event.id, details: { rsvpNumber } });
  }
  return ok(response, { person: personView(event, row), counts: counts(rows) });
}

// What the page did while offline, replayed in order.
async function sync(request, response, event, body, user) {
  if (!Array.isArray(body.entries) || body.entries.length > SYNC_LIMIT) {
    return fail(response, 400, 'bad_request');
  }
  const rows = await attendeeRows(event.id);
  const results = [];
  let applied = 0;
  for (const entry of body.entries) {
    let rsvpNumber = NaN;
    if (entry && typeof entry === 'object') {
      rsvpNumber = Number(entry.rsvpNumber);
    }
    const row = rows.find((each) => each.rsvp_number === rsvpNumber);
    if (!row) {
      results.push({ rsvpNumber, ok: false, error: 'checkin_not_found' });
      continue;
    }
    if (entry.undo === true) {
      await markOut(event, row);
      results.push({ rsvpNumber, ok: true });
      applied += 1;
      continue;
    }
    if (event.status === 'cancelled') {
      results.push({ rsvpNumber, ok: false, error: 'event_cancelled' });
      continue;
    }
    let at = Date.parse(entry.at);
    const now = Date.now();
    if (!Number.isFinite(at) || at > now || now - at > SYNC_MAX_AGE_MS) {
      at = now;
    }
    let how = 'manual';
    if (entry.how === 'scan') {
      how = 'scan';
    }
    const already = await markIn(event, row, user, how, entry.idChecked === true, new Date(at).toISOString());
    results.push({ rsvpNumber, ok: true, already });
    applied += 1;
  }
  if (applied > 0) {
    await audit(request, { action: 'checkin.synced', actorId: user.id, eventId: event.id, details: { entries: applied } });
  }
  return ok(response, { results, counts: counts(rows) });
}

async function setBeacon(request, response, event, body, user) {
  if (typeof body.on !== 'boolean') {
    return fail(response, 400, 'bad_request');
  }
  if (body.on && event.status === 'cancelled') {
    return fail(response, 409, 'event_cancelled');
  }
  const { error } = await database().from(TABLES.events).update({ self_checkin_on: body.on }).eq('id', event.id);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'checkin.beacon', actorId: user.id, eventId: event.id, details: { on: body.on } });
  return ok(response, { selfCheckin: body.on });
}

export default route('manage/checkin', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  const user = session.user;
  let body = null;
  let eventId = query(request, 'id');
  if (request.method === 'POST') {
    body = await readJson(request, response, { maxBytes: 256 * 1024 });
    if (!body) {
      return;
    }
    if (await limited(request, response, 'checkin', [`u:${user.id}`])) {
      return;
    }
    eventId = String(body.id);
  }
  if (!UUID_PATTERN.test(eventId)) {
    return fail(response, 400, 'bad_request');
  }
  eventId = eventId.toLowerCase();
  // An event this person does not edit answers as a missing one.
  if (!(await canEditEvent(user, eventId))) {
    return fail(response, 404, 'not_found');
  }
  const event = await loadEvent(eventId);
  if (!event) {
    return fail(response, 404, 'not_found');
  }

  if (request.method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    if (query(request, 'beacon') === '1') {
      if (event.self_checkin_on !== true || event.status === 'cancelled') {
        return fail(response, 409, 'self_checkin_off');
      }
      return ok(response, { beacon: { codes: beaconCodesAhead(event.id, event.slug) } });
    }
    const rows = await attendeeRows(event.id);
    return ok(response, { event: eventView(event), attendees: rows.map((row) => listedView(event, row)), counts: counts(rows) });
  }

  if (body.action === 'checkin') {
    return checkIn(request, response, event, body, user);
  }
  if (body.action === 'undo') {
    return undo(request, response, event, body, user);
  }
  if (body.action === 'sync') {
    return sync(request, response, event, body, user);
  }
  if (body.action === 'beacon') {
    return setBeacon(request, response, event, body, user);
  }
  return fail(response, 400, 'bad_request');
});
