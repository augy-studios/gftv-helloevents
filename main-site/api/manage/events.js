// Editors' event management. Editors and admins only (is_approved, and
// is_editor or is_admin on the shared account), re-checked on every request.
//
// GET                         -> { events: [summary] }   every event, any status
// GET ?id=<uuid>              -> { event, attendees }    one event, for editing
// POST { action: "create", event }                 -> { event }
// POST { action: "update", id, event }             -> { event }
// POST { action: "delete", id }                    admins only
// POST { action: "remove-attendee", id, username } take someone off the list
//
// event is the edit form's fields (event-rules.js validateEvent picks what it
// knows and ignores the rest). Answers are built by serialize.js, never rows.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { isAdmin } from '../_lib/users.js';
import { validateEvent } from '../_lib/event-rules.js';
import { MANAGE_COLUMNS } from '../_lib/events.js';
import { managedSummary, managedEvent, attendeeView } from '../_lib/serialize.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadEvent(id) {
  const { data, error } = await db().from(T.events).select(MANAGE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadAttendees(eventId) {
  const { data, error } = await db()
    .from(T.attendees)
    .select(`created_at, user:${T.users} ( username, display_name )`)
    .eq('event_id', eventId)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) throw error;
  return (data ?? []).map(attendeeView);
}

function saveError(res, error) {
  if (error.code === '23505') return fail(res, 409, 'slug_taken');
  if (error.code === '23514') return fail(res, 400, 'invalid_field', { field: 'event' });
  throw error;
}

export default route('manage/events', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const session = await requireUser(req, res, { manage: true });
  if (!session) return;
  const user = session.user;

  if (req.method === 'GET') {
    const id = query(req, 'id');
    if (id) {
      if (!UUID.test(id)) return fail(res, 400, 'bad_request');
      const row = await loadEvent(id);
      if (!row) return fail(res, 404, 'not_found');
      return ok(res, { event: managedEvent(row), attendees: await loadAttendees(row.id) });
    }
    const { data, error } = await db()
      .from(T.events)
      .select('id, slug, title, kind, status, publish_at, starts_at, dates_hidden, timezone, capacity, updated_at, gftvevents_attendees(count)')
      .order('updated_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    const now = Date.now();
    return ok(res, { events: (data ?? []).map((row) => managedSummary(row, now)) });
  }

  const body = await readJson(req, res, { maxBytes: 64 * 1024 });
  if (!body) return;
  if (await limited(req, res, 'manageWrite', [`u:${user.id}`])) return;

  if (body.action === 'create' || body.action === 'update') {
    const check = validateEvent(body.event);
    if (!check.ok) return fail(res, 400, check.error, { field: check.field });
    const fields = { ...check.fields, updated_by: user.id };

    if (body.action === 'create') {
      const { data, error } = await db()
        .from(T.events)
        .insert({ ...fields, created_by: user.id })
        .select(MANAGE_COLUMNS)
        .single();
      if (error) return saveError(res, error);
      await audit(req, { action: 'event.created', actorId: user.id, eventId: data.id, details: { status: data.status } });
      return ok(res, { event: managedEvent(data) });
    }

    if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');
    const { data, error } = await db()
      .from(T.events)
      .update(fields)
      .eq('id', body.id)
      .select(MANAGE_COLUMNS)
      .maybeSingle();
    if (error) return saveError(res, error);
    if (!data) return fail(res, 404, 'not_found');
    await audit(req, { action: 'event.updated', actorId: user.id, eventId: data.id, details: { status: data.status } });
    return ok(res, { event: managedEvent(data) });
  }

  if (body.action === 'delete') {
    if (!isAdmin(user)) return fail(res, 403, 'admin_only');
    if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');
    const { data, error } = await db().from(T.events).delete().eq('id', body.id).select('id, slug');
    if (error) throw error;
    if (!data?.length) return fail(res, 404, 'not_found');
    // event_id is set null on the audit rows by the foreign key, so the slug
    // goes in the details to keep the trail readable.
    await audit(req, { action: 'event.deleted', actorId: user.id, details: { slug: data[0].slug } });
    return ok(res, { deleted: true });
  }

  if (body.action === 'remove-attendee') {
    if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');
    const username = String(body.username ?? '').trim();
    if (!username || username.length > 64) return fail(res, 400, 'bad_request');
    const { data: person, error: personError } = await db().from(T.users).select('id').eq('username', username).maybeSingle();
    if (personError) throw personError;
    if (!person) return fail(res, 404, 'not_found');
    const { error } = await db().from(T.attendees).delete().eq('event_id', body.id).eq('user_id', person.id);
    if (error) throw error;
    await audit(req, { action: 'rsvp.removed_by_editor', actorId: user.id, eventId: body.id, details: { username } });
    return ok(res, { attendees: await loadAttendees(body.id) });
  }

  fail(res, 400, 'bad_request');
});
