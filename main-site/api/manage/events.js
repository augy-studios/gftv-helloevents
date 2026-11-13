// Editors' event management. Editors and admins only (is_approved, and
// is_editor or is_admin on the shared account), re-checked on every request.
//
// GET                         -> { events: [summary] }   every event, any status
// GET ?id=<uuid>              -> { event, attendees }    one event, for editing
// POST { action: "create", event }                 -> { event }
// POST { action: "update", id, event }             -> { event }
// POST { action: "delete", id }                    admins only
// POST { action: "remove-attendee", id, username, staff } take someone off
//
// Saving a change to when or where a released event happens, or cancelling
// it, tells the people going (notify.js), in the background.
//
// event is the edit form's fields (event-rules.js validateEvent picks what it
// knows and ignores the rest). Answers are built by serialize.js, never rows.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { isAdmin } from '../_lib/users.js';
import { validateEvent } from '../_lib/event-rules.js';
import { MANAGE_COLUMNS } from '../_lib/events.js';
import { managedSummary, managedEvent, attendeeView } from '../_lib/serialize.js';
import { deleteCover } from '../_lib/covers.js';
import { background, notifyEventChange } from '../_lib/notify.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whether a body field is a UUID, once turned into a string (a missing field
// is read as '', which is not).
function isUuid(value) {
  let text = '';
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  return UUID_PATTERN.test(text);
}

async function loadEvent(eventId) {
  const { data, error } = await database().from(TABLES.events).select(MANAGE_COLUMNS).eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The event's attendees in RSVP order, as the edit page lists them.
async function loadAttendees(eventId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(
      `created_at, account:${TABLES.accounts} ( kind, username, display_name, staff:${TABLES.users} ( username, display_name ) )`
    )
    .eq('event_id', eventId)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) {
    throw error;
  }
  let rows = [];
  if (data !== null && data !== undefined) {
    rows = data;
  }
  return rows.map(attendeeView);
}

// A failed save the editor can fix gets its own answer: a slug already in
// use, or a value the database's checks refused. Anything else is thrown.
function answerSaveError(response, error) {
  if (error.code === '23505') {
    return fail(response, 409, 'slug_taken');
  }
  if (error.code === '23514') {
    return fail(response, 400, 'invalid_field', { field: 'event' });
  }
  throw error;
}

// GET ?id=: one event for the edit form, with its attendees.
async function showEvent(response, eventId) {
  if (!UUID_PATTERN.test(eventId)) {
    return fail(response, 400, 'bad_request');
  }
  const row = await loadEvent(eventId);
  if (!row) {
    return fail(response, 404, 'not_found');
  }
  const event = managedEvent(row);
  const attendees = await loadAttendees(row.id);
  return ok(response, { event, attendees });
}

// GET: every event, any status, most recently changed first.
async function listEvents(response) {
  const { data, error } = await database()
    .from(TABLES.events)
    .select('id, slug, title, kind, status, publish_at, starts_at, dates_hidden, capacity, gftvevents_attendees(count)')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) {
    throw error;
  }
  const now = Date.now();
  let rows = [];
  if (data !== null && data !== undefined) {
    rows = data;
  }
  return ok(response, { events: rows.map((row) => managedSummary(row, now)) });
}

// "create": a new event from the checked fields.
async function createEvent(request, response, fields, user) {
  const { data, error } = await database()
    .from(TABLES.events)
    .insert({ ...fields, created_by: user.id })
    .select(MANAGE_COLUMNS)
    .single();
  if (error) {
    return answerSaveError(response, error);
  }
  await audit(request, { action: 'event.created', actorId: user.id, eventId: data.id, details: { status: data.status } });
  return ok(response, { event: managedEvent(data) });
}

// "update": saves the checked fields over an existing event, then tells the
// people going about a change of when or where (or a cancellation), in the
// background.
async function updateEvent(request, response, body, fields, user) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const before = await loadEvent(body.id);
  if (!before) {
    return fail(response, 404, 'not_found');
  }
  const { data, error } = await database()
    .from(TABLES.events)
    .update(fields)
    .eq('id', body.id)
    .select(MANAGE_COLUMNS)
    .maybeSingle();
  if (error) {
    return answerSaveError(response, error);
  }
  if (!data) {
    return fail(response, 404, 'not_found');
  }
  await audit(request, { action: 'event.updated', actorId: user.id, eventId: data.id, details: { status: data.status } });
  background(notifyEventChange(before, data));
  return ok(response, { event: managedEvent(data) });
}

// "create" and "update": the edit form's fields are checked first, and the
// editor is recorded as the last to change the event.
async function saveEvent(request, response, body, user) {
  const check = validateEvent(body.event);
  if (!check.ok) {
    return fail(response, 400, check.error, { field: check.field });
  }
  const fields = { ...check.fields, updated_by: user.id };
  if (body.action === 'create') {
    return createEvent(request, response, fields, user);
  }
  return updateEvent(request, response, body, fields, user);
}

// "delete", admins only: the event and its cover picture.
async function deleteEvent(request, response, body, user) {
  if (!isAdmin(user)) {
    return fail(response, 403, 'admin_only');
  }
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const { data, error } = await database()
    .from(TABLES.events)
    .delete()
    .eq('id', body.id)
    .select('id, slug, cover_image_path');
  if (error) {
    throw error;
  }
  if (data === null || data === undefined || !data.length) {
    return fail(response, 404, 'not_found');
  }
  const deleted = data[0];
  await deleteCover(deleted.cover_image_path);
  // event_id is set null on the audit rows by the foreign key, so the slug
  // goes in the details to keep the trail readable.
  await audit(request, { action: 'event.deleted', actorId: user.id, details: { slug: deleted.slug } });
  return ok(response, { deleted: true });
}

// Whether an attendee row is the person the editor named: the same username
// and, when the page says which, the same kind of account (staff or not).
function isNamedAttendee(row, username, staff) {
  let account = {};
  if (row.account !== null && row.account !== undefined) {
    account = row.account;
  }
  const isStaff = account.kind === 'staff';
  let attendeeUsername;
  if (isStaff) {
    if (account.staff !== null && account.staff !== undefined) {
      attendeeUsername = account.staff.username;
    }
  } else {
    attendeeUsername = account.username;
  }
  if (attendeeUsername !== username) {
    return false;
  }
  if (staff === undefined) {
    return true;
  }
  return staff === isStaff;
}

// "remove-attendee": takes someone off an event, by username.
async function removeAttendee(request, response, body, user) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  let typedUsername = '';
  if (body.username !== null && body.username !== undefined) {
    typedUsername = body.username;
  }
  const username = String(typedUsername).trim();
  if (!username || username.length > 64) {
    return fail(response, 400, 'bad_request');
  }
  // Matched against this event's own list, so only someone on it can go.
  const { data: attendeeData, error: attendeesError } = await database()
    .from(TABLES.attendees)
    .select(`user_id, account:${TABLES.accounts} ( kind, username, staff:${TABLES.users} ( username ) )`)
    .eq('event_id', body.id);
  if (attendeesError) {
    throw attendeesError;
  }
  let attendeeRows = [];
  if (attendeeData !== null && attendeeData !== undefined) {
    attendeeRows = attendeeData;
  }
  const match = attendeeRows.find((row) => isNamedAttendee(row, username, body.staff));
  if (!match) {
    return fail(response, 404, 'not_found');
  }
  const { error } = await database()
    .from(TABLES.attendees)
    .delete()
    .eq('event_id', body.id)
    .eq('user_id', match.user_id);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'rsvp.removed_by_editor', actorId: user.id, eventId: body.id, details: { username } });
  return ok(response, { attendees: await loadAttendees(body.id) });
}

// Sends each request to its step. Every POST counts against the manageWrite
// limit.
export default route('manage/events', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true });
  if (!session) {
    return;
  }
  const user = session.user;

  if (request.method === 'GET') {
    const eventId = query(request, 'id');
    if (eventId) {
      await showEvent(response, eventId);
      return;
    }
    await listEvents(response);
    return;
  }

  const body = await readJson(request, response, { maxBytes: 64 * 1024 });
  if (!body) {
    return;
  }
  if (await limited(request, response, 'manageWrite', [`u:${user.id}`])) {
    return;
  }

  if (body.action === 'create' || body.action === 'update') {
    await saveEvent(request, response, body, user);
    return;
  }
  if (body.action === 'delete') {
    await deleteEvent(request, response, body, user);
    return;
  }
  if (body.action === 'remove-attendee') {
    await removeAttendee(request, response, body, user);
    return;
  }
  fail(response, 400, 'bad_request');
});
