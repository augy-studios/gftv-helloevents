// Editors' event management. Editors and admins only (is_approved, and
// is_editor or is_admin on the shared account), re-checked on every request.
//
// GET                         -> { events: [summary] }   every event, any status
// GET ?id=<uuid>              -> { event, attendees }    one event, for editing
// GET ?checkSlug=<slug>&id=<uuid> -> { free }            whether an event link is
//                                                        free (id: the event asking,
//                                                        whose own link counts as free)
// POST { action: "create", event }                 -> { event }
// POST { action: "update", id, event }             -> { event }
// POST { action: "delete", id }                    admins only
// POST { action: "remove-attendee", id, username, staff } take someone off
// POST { action: "volunteer-confirm", id, username, staff, volunteered }
//                              a convention only: mark that someone going did
//                              (or did not) volunteer at it (migrations/012)
// POST { action: "payment-confirm", id, username, staff, paid }
//                              mark someone's ticket paid, after checking
//                              their payment (or take that back); telling
//                              them when it is confirmed (migrations/016)
//
// Editors of one event (migrations/018) reach only the events they edit:
// the list shows only those, and anything else answers 404. They cannot
// create or delete events, and a save of theirs keeps the Status and the
// release time as they are (staff decide when an event goes live).
//
// Saving a change to when or where a released event happens, to its
// timetable, or cancelling it, tells the people going (notify.js), in the
// background, once for a run of autosaves.
//
// event is the edit form's fields (event-rules.js validateEvent picks what it
// knows and ignores the rest). Answers are built by serialize.js, never rows.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { isAdmin } from '../_lib/users.js';
import { validateEvent, isSlug, volunteerDiscountActive, storedTiers, VOLUNTEER_KIND } from '../_lib/event-rules.js';
import { MANAGE_COLUMNS, PAYMENT_COLUMNS, confirmedVolunteers } from '../_lib/events.js';
import { managedSummary, managedEvent, attendeeView } from '../_lib/serialize.js';
import { deleteCover } from '../_lib/covers.js';
import { galleryRows, deleteGalleryFiles } from '../_lib/gallery.js';
import { withDescriptionPictures } from '../_lib/description-pictures.js';
import { deletePaymentFiles, proofPaths, registrationPhotoPaths } from '../_lib/payments.js';
import { editableEventIds } from '../_lib/event-editors.js';
import { background, queueEventChange, sendEventChangeWhenDue, sendPaymentConfirmed } from '../_lib/notify.js';

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

async function loadEvent(eventId, columns = MANAGE_COLUMNS) {
  const { data, error } = await database().from(TABLES.events).select(columns).eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The event columns the attendee list needs: the meals it offers, and its
// kind and volunteer benefit, for who volunteered.
const ATTENDEE_EVENT_COLUMNS = 'id, slug, kind, cross_border, meal_options, volunteer_discount_enabled, volunteer_discount_from, volunteer_discount_value, contact_fields, ' +
  'fursuiters_asked, price_type, starts_at, timezone, registration_enabled, registration_fields';

// The event's attendees in RSVP order, as the edit page lists them, each
// with the meals they are coming for that the event still offers, and for
// a convention, whether an editor confirmed they volunteered at it and at
// the earlier convention its volunteer benefit is for.
// event: its row, with at least ATTENDEE_EVENT_COLUMNS.
async function loadAttendees(event) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(
      `user_id, rsvp_number, created_at, meals, lepak, volunteer, fursuiter, contact, registration, ${PAYMENT_COLUMNS}, ` +
        `account:${TABLES.accounts}!user_id ( kind, username, display_name, country, legal_name, date_of_birth, emergency_name, emergency_phone, staff:${TABLES.users} ( username, display_name ) )`
    )
    .eq('event_id', event.id)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) {
    throw error;
  }
  let rows = [];
  if (data !== null && data !== undefined) {
    rows = data;
  }
  const userIds = rows.map((row) => row.user_id);
  let confirmed = new Set();
  if (event.kind === VOLUNTEER_KIND) {
    confirmed = await confirmedVolunteers(event.id, userIds);
  }
  let earlier = new Set();
  if (volunteerDiscountActive(event)) {
    earlier = await confirmedVolunteers(event.volunteer_discount_from, userIds);
  }
  return rows.map((row) => attendeeView(row, event, {
    volunteered: confirmed.has(row.user_id),
    pastVolunteer: earlier.has(row.user_id),
  }));
}

// Whether the earlier convention a volunteer benefit names can be used:
// none named, or an event that exists, is a convention, and is not this one
// (eventId: the event being saved; undefined for a new one).
async function volunteerSourceAllowed(fields, eventId) {
  const sourceId = fields.volunteer_discount_from;
  if (!sourceId) {
    return true;
  }
  if (sourceId === eventId) {
    return false;
  }
  const source = await loadEvent(sourceId, 'id, kind');
  if (!source) {
    return false;
  }
  return source.kind === VOLUNTEER_KIND;
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
  await withDescriptionPictures(row);
  const event = managedEvent(row);
  const attendees = await loadAttendees(row);
  return ok(response, { event, attendees });
}

// GET ?checkSlug=: whether no other event has this link, so the edit form
// can say so before saving. A link that is not a valid one answers free:
// saving it then says what is wrong with it.
async function checkSlug(response, slug, eventId) {
  const wanted = String(slug).trim().toLowerCase();
  if (!isSlug(wanted)) {
    return ok(response, { free: true });
  }
  const { data, error } = await database().from(TABLES.events).select('id').eq('slug', wanted).maybeSingle();
  if (error) {
    throw error;
  }
  let free = !data;
  if (data && UUID_PATTERN.test(eventId) && data.id === eventId) {
    free = true;
  }
  return ok(response, { free });
}

// GET: every event, any status, most recently changed first.
async function listEvents(response, scope) {
  if (scope !== null && scope.length === 0) {
    return ok(response, { events: [] });
  }
  let request = database()
    .from(TABLES.events)
    .select(`id, slug, title, kind, status, publish_at, starts_at, dates_hidden, capacity, ${TABLES.fullAttendees}(count)`);
  if (scope !== null) {
    request = request.in('id', scope);
  }
  const { data, error } = await request
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

// How many numbered addresses ("mega-con-2", "mega-con-3", ...) a new event
// tries when the one made from its title is taken.
const SLUG_TRIES = 20;

// Whether the form named the event's address. The edit form no longer has
// the field, so the address is made from the title (event-rules.js) and kept
// from then on; only an API caller sends one.
function slugGiven(event) {
  if (event === null || event === undefined || typeof event !== 'object') {
    return false;
  }
  if (event.slug === null || event.slug === undefined) {
    return false;
  }
  return String(event.slug).trim() !== '';
}

// "create": a new event from the checked fields. An address made from the
// title that another event already uses gets a number on the end instead;
// one the caller chose is refused (slug_taken).
async function createEvent(request, response, fields, user, { numberSlug }) {
  let attempt = 1;
  let data;
  let error;
  while (attempt <= SLUG_TRIES) {
    let slug = fields.slug;
    if (attempt > 1) {
      slug = `${fields.slug}-${attempt}`;
    }
    ({ data, error } = await database()
      .from(TABLES.events)
      .insert({ ...fields, slug, created_by: user.id })
      .select(MANAGE_COLUMNS)
      .single());
    if (!error || error.code !== '23505' || !numberSlug) {
      break;
    }
    attempt += 1;
  }
  if (error) {
    return answerSaveError(response, error);
  }
  await audit(request, { action: 'event.created', actorId: user.id, eventId: data.id, details: { status: data.status } });
  await withDescriptionPictures(data);
  return ok(response, { event: managedEvent(data) });
}

// "update": saves the checked fields over an existing event. A change of
// when or where (or a cancellation) is queued for the people going and sent
// in the background once the editor stops saving (notify.js).
async function updateEvent(request, response, body, fields, user) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const before = await loadEvent(body.id, `${MANAGE_COLUMNS}, notice_base`);
  if (!before) {
    return fail(response, 404, 'not_found');
  }
  // The address stays as it is unless the caller names a new one, so a new
  // title never moves the event's page.
  const changes = { ...fields };
  // A tier's QR code is uploaded on its own (api/manage/payment-qr.js), so
  // the form never sends it: each tier keeps its own, found by its id.
  const tierQrBefore = new Map(storedTiers(before).map((tier) => [tier.id, tier.payment_qr_path]));
  if (Array.isArray(changes.ticket_tiers)) {
    for (const tier of changes.ticket_tiers) {
      let path = tierQrBefore.get(tier.id);
      if (path === undefined) {
        path = null;
      }
      tier.payment_qr_path = path;
    }
  }
  if (!slugGiven(body.event)) {
    changes.slug = before.slug;
  }
  Object.assign(changes, queueEventChange(before, changes));
  const { data, error } = await database()
    .from(TABLES.events)
    .update(changes)
    .eq('id', body.id)
    .select(MANAGE_COLUMNS)
    .maybeSingle();
  if (error) {
    return answerSaveError(response, error);
  }
  if (!data) {
    return fail(response, 404, 'not_found');
  }
  // The QR codes of tiers taken away.
  const tierQrAfter = new Set(storedTiers(data).map((tier) => tier.payment_qr_path));
  await deletePaymentFiles([...tierQrBefore.values()].filter((path) => !tierQrAfter.has(path)));
  await audit(request, { action: 'event.updated', actorId: user.id, eventId: data.id, details: { status: data.status } });
  if (changes.notice_due_at) {
    background(sendEventChangeWhenDue(data.id));
  }
  await withDescriptionPictures(data);
  return ok(response, { event: managedEvent(data) });
}

// "create" and "update": the edit form's fields are checked first, and the
// editor is recorded as the last to change the event.
async function saveEvent(request, response, body, user) {
  const check = validateEvent(body.event);
  if (!check.ok) {
    const detail = { field: check.field };
    if (check.location !== undefined) {
      detail.location = check.location;
    }
    if (check.tier !== undefined) {
      detail.tier = check.tier;
    }
    if (check.meal !== undefined) {
      detail.meal = check.meal;
    }
    if (check.item !== undefined) {
      detail.item = check.item;
    }
    if (check.room !== undefined) {
      detail.room = check.room;
    }
    if (check.contact !== undefined) {
      detail.contact = check.contact;
    }
    return fail(response, 400, check.error, detail);
  }
  let savedId;
  if (body.action === 'update' && isUuid(body.id)) {
    savedId = String(body.id).toLowerCase();
  }
  if (!(await volunteerSourceAllowed(check.fields, savedId))) {
    return fail(response, 400, 'invalid_field', { field: 'volunteerDiscountFrom' });
  }
  const fields = { ...check.fields, updated_by: user.id };
  // An editor of one event (migrations/018) cannot change when it goes live.
  if (user.scope !== null) {
    delete fields.status;
    delete fields.publish_at;
  }
  if (body.action === 'create') {
    return createEvent(request, response, fields, user, { numberSlug: !slugGiven(body.event) });
  }
  return updateEvent(request, response, body, fields, user);
}

// "delete", admins only: the event, its cover picture and its gallery.
async function deleteEvent(request, response, body, user) {
  if (!isAdmin(user)) {
    return fail(response, 403, 'admin_only');
  }
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  // The attendees' payment screenshots and registration photos go with the
  // event.
  const proofs = [...(await proofPaths(body.id)), ...(await registrationPhotoPaths(body.id))];
  // So are the gallery's files; its rows go with the event.
  const galleryPaths = (await galleryRows(body.id)).map((image) => image.path);
  const { data, error } = await database()
    .from(TABLES.events)
    .delete()
    .eq('id', body.id)
    .select('id, slug, cover_image_path, payment_qr_path, ticket_tiers');
  if (error) {
    throw error;
  }
  if (data === null || data === undefined || !data.length) {
    return fail(response, 404, 'not_found');
  }
  const deleted = data[0];
  await deleteCover(deleted.cover_image_path);
  await deleteGalleryFiles(galleryPaths);
  const tierQrs = storedTiers(deleted).map((tier) => tier.payment_qr_path);
  await deletePaymentFiles([deleted.payment_qr_path, ...tierQrs, ...proofs]);
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

// The username an attendee action names, trimmed, or null when it is
// missing or too long.
function namedUsername(body) {
  let typedUsername = '';
  if (body.username !== null && body.username !== undefined) {
    typedUsername = body.username;
  }
  const username = String(typedUsername).trim();
  if (!username || username.length > 64) {
    return null;
  }
  return username;
}

// The attendee row of the person an editor named on this event's own list,
// so only someone on it can be acted on: { user_id } or null.
async function findAttendee(eventId, username, staff) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`user_id, account:${TABLES.accounts}!user_id ( kind, username, staff:${TABLES.users} ( username ) )`)
    .eq('event_id', eventId);
  if (error) {
    throw error;
  }
  let rows = [];
  if (data !== null && data !== undefined) {
    rows = data;
  }
  const match = rows.find((row) => isNamedAttendee(row, username, staff));
  if (!match) {
    return null;
  }
  return match;
}

// "remove-attendee": takes someone off an event, by username, along with
// any confirmation that they volunteered at it.
async function removeAttendee(request, response, body, user) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const username = namedUsername(body);
  if (!username) {
    return fail(response, 400, 'bad_request');
  }
  const event = await loadEvent(body.id, ATTENDEE_EVENT_COLUMNS);
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  const match = await findAttendee(body.id, username, body.staff);
  if (!match) {
    return fail(response, 404, 'not_found');
  }
  const proofs = [...(await proofPaths(body.id, match.user_id)), ...(await registrationPhotoPaths(body.id, match.user_id))];
  for (const table of [TABLES.attendees, TABLES.volunteers]) {
    const { error } = await database()
      .from(table)
      .delete()
      .eq('event_id', body.id)
      .eq('user_id', match.user_id);
    if (error) {
      throw error;
    }
  }
  await deletePaymentFiles(proofs);
  await audit(request, { action: 'rsvp.removed_by_editor', actorId: user.id, eventId: body.id, details: { username } });
  return ok(response, { attendees: await loadAttendees(event) });
}

// "volunteer-confirm": marks that someone going to a convention really
// volunteered at it (volunteered: true), or takes that back (false). Only
// those confirmed get a later convention's volunteer benefit.
async function confirmVolunteer(request, response, body, user) {
  if (!isUuid(body.id) || typeof body.volunteered !== 'boolean') {
    return fail(response, 400, 'bad_request');
  }
  const username = namedUsername(body);
  if (!username) {
    return fail(response, 400, 'bad_request');
  }
  const event = await loadEvent(body.id, ATTENDEE_EVENT_COLUMNS);
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  if (event.kind !== VOLUNTEER_KIND) {
    return fail(response, 400, 'volunteers_convention_only');
  }
  const match = await findAttendee(body.id, username, body.staff);
  if (!match) {
    return fail(response, 404, 'not_found');
  }
  let result;
  if (body.volunteered) {
    result = await database()
      .from(TABLES.volunteers)
      .upsert({ event_id: body.id, user_id: match.user_id, confirmed_by: user.id, confirmed_at: new Date().toISOString() });
  } else {
    result = await database()
      .from(TABLES.volunteers)
      .delete()
      .eq('event_id', body.id)
      .eq('user_id', match.user_id);
  }
  if (result.error) {
    throw result.error;
  }
  let action = 'volunteer.unconfirmed';
  if (body.volunteered) {
    action = 'volunteer.confirmed';
  }
  await audit(request, { action, actorId: user.id, eventId: body.id, details: { username } });
  return ok(response, { attendees: await loadAttendees(event) });
}

// "payment-confirm": marks someone's ticket paid (paid: true) once an editor
// has checked their payment, or takes that back (false: back to waiting for
// a check, or for payment when nothing was reported). Only a ticket with a
// payment to make (by link or QR code). Confirming tells them.
async function confirmPayment(request, response, body, user) {
  if (!isUuid(body.id) || typeof body.paid !== 'boolean') {
    return fail(response, 400, 'bad_request');
  }
  const username = namedUsername(body);
  if (!username) {
    return fail(response, 400, 'bad_request');
  }
  const event = await loadEvent(body.id);
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  const match = await findAttendee(body.id, username, body.staff);
  if (!match) {
    return fail(response, 404, 'not_found');
  }
  const { data: stored, error } = await database()
    .from(TABLES.attendees)
    .select(PAYMENT_COLUMNS)
    .eq('event_id', body.id)
    .eq('user_id', match.user_id)
    .single();
  if (error) {
    throw error;
  }
  if (!['awaiting', 'submitted', 'paid'].includes(stored.payment_status)) {
    return fail(response, 400, 'payment_not_online');
  }
  let columns;
  if (body.paid) {
    columns = { payment_status: 'paid', paid_at: new Date().toISOString(), paid_by: user.id };
  } else {
    let status = 'awaiting';
    if (stored.payment_reference) {
      status = 'submitted';
    }
    columns = { payment_status: status, paid_at: null, paid_by: null };
  }
  const { error: saveError } = await database()
    .from(TABLES.attendees)
    .update(columns)
    .eq('event_id', body.id)
    .eq('user_id', match.user_id);
  if (saveError) {
    throw saveError;
  }
  let action = 'payment.unconfirmed';
  if (body.paid) {
    action = 'payment.confirmed';
  }
  await audit(request, { action, actorId: user.id, eventId: body.id, details: { username } });
  if (body.paid && stored.payment_status !== 'paid') {
    background(sendPaymentConfirmed(event, match.user_id));
  }
  return ok(response, { attendees: await loadAttendees(event) });
}

// Sends each request to its step. Every POST counts against the manageWrite
// limit.
export default route('manage/events', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  // The events this person may reach: null for every one, otherwise the ids
  // of the events they edit (migrations/018).
  const user = { ...session.user, scope: await editableEventIds(session.user) };
  const outOfScope = (eventId) => {
    if (user.scope === null) {
      return false;
    }
    return !user.scope.includes(String(eventId).toLowerCase());
  };

  if (request.method === 'GET') {
    const eventId = query(request, 'id');
    const slugToCheck = query(request, 'checkSlug');
    if (slugToCheck) {
      await checkSlug(response, slugToCheck, eventId);
      return;
    }
    if (eventId) {
      if (outOfScope(eventId)) {
        fail(response, 404, 'not_found');
        return;
      }
      await showEvent(response, eventId);
      return;
    }
    await listEvents(response, user.scope);
    return;
  }

  // A whole form, with a con's timetable (a few hundred items) and both rich
  // text descriptions as the editor sends them, fits well inside this.
  const body = await readJson(request, response, { maxBytes: 1024 * 1024 });
  if (!body) {
    return;
  }
  if (await limited(request, response, 'manageWrite', [`u:${user.id}`])) {
    return;
  }
  // An editor of one event: only its own, and never a new one.
  if (user.scope !== null && body.action === 'create') {
    fail(response, 403, 'manage_only');
    return;
  }
  if (user.scope !== null && body.action !== 'create' && outOfScope(body.id)) {
    fail(response, 404, 'not_found');
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
  if (body.action === 'payment-confirm') {
    await confirmPayment(request, response, body, user);
    return;
  }
  if (body.action === 'volunteer-confirm') {
    await confirmVolunteer(request, response, body, user);
    return;
  }
  fail(response, 400, 'bad_request');
});
