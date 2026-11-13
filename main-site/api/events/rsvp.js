// POST /api/events/rsvp  { slug, going: true | false }
//
// RSVP for a signed-in person (a session that passed the second factor).
// Joining goes through the gftvevents_rsvp database function, which locks the
// event row, so two people cannot both take the last space. Only released,
// open, not-yet-over events can be joined; anything else answers the same
// way as a missing event.
//
// -> { event } as the person now sees it (event.viewer.going says whether
// they are going).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canManage } from '../_lib/users.js';
import { releasedEventBySlug } from '../_lib/events.js';
import { publicEventDetail } from '../_lib/serialize.js';

// What the gftvevents_rsvp database function can answer: null for a place
// taken (now or before), or the status and error code to refuse with.
const RESULTS = {
  ok: null,
  already: null,
  not_found: [404, 'not_found'],
  rsvp_closed: [409, 'rsvp_closed'],
  event_full: [409, 'event_full'],
  event_over: [409, 'event_over'],
};

// Joins (going: true) or leaves (going: false) a released event, then
// answers with the event as this person now sees it.
export default route('events/rsvp', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'rsvp', [`u:${session.user.id}`])) {
    return;
  }

  let typedSlug = '';
  if (body.slug !== null && body.slug !== undefined) {
    typedSlug = body.slug;
  }
  const event = await releasedEventBySlug(String(typedSlug).toLowerCase());
  if (!event) {
    return fail(response, 404, 'not_found');
  }

  if (body.going === true) {
    const { data, error } = await database().rpc('gftvevents_rsvp', { p_event_id: event.id, p_user_id: session.user.id });
    if (error) {
      throw error;
    }
    const result = String(data);
    if (!(result in RESULTS)) {
      throw new Error(`unexpected rsvp result ${result}`);
    }
    const refusal = RESULTS[result];
    if (refusal) {
      const status = refusal[0];
      const errorCode = refusal[1];
      return fail(response, status, errorCode);
    }
    if (result === 'ok') {
      await audit(request, { action: 'rsvp.going', actorId: session.user.id, eventId: event.id });
    }
  } else if (body.going === false) {
    const { error } = await database()
      .from(TABLES.attendees)
      .delete()
      .eq('event_id', event.id)
      .eq('user_id', session.user.id);
    if (error) {
      throw error;
    }
    await audit(request, { action: 'rsvp.cancelled', actorId: session.user.id, eventId: event.id });
  } else {
    return fail(response, 400, 'bad_request');
  }

  // Read it again, so the count and spaces left are current. If it has gone
  // in the meantime, the copy read before is shown.
  const fresh = await releasedEventBySlug(event.slug);
  let shown = event;
  if (fresh !== null && fresh !== undefined) {
    shown = fresh;
  }
  ok(response, {
    event: publicEventDetail(shown, {
      signedIn: true,
      going: body.going === true,
      canManage: canManage(session.user),
    }),
  });
});
