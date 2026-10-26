// POST /api/events/rsvp  { slug, going: true | false }
//
// RSVP for a signed-in person (a session that passed the second factor).
// Joining goes through the gftvevents_rsvp database function, which locks the
// event row, so two people cannot both take the last space. Only released,
// open, not-yet-over events can be joined; anything else answers the same
// way as a missing event.
//
// -> { going, event } with the event as the person now sees it.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canManage } from '../_lib/users.js';
import { releasedEventBySlug } from '../_lib/events.js';
import { publicEventDetail } from '../_lib/serialize.js';

const RESULTS = {
  ok: null,
  already: null,
  not_found: [404, 'not_found'],
  rsvp_closed: [409, 'rsvp_closed'],
  event_full: [409, 'event_full'],
  event_over: [409, 'event_over'],
};

export default route('events/rsvp', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const session = await requireUser(req, res);
  if (!session) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'rsvp', [`u:${session.user.id}`])) return;

  const event = await releasedEventBySlug(String(body.slug ?? '').toLowerCase());
  if (!event) return fail(res, 404, 'not_found');

  if (body.going === true) {
    const { data, error } = await db().rpc('gftvevents_rsvp', { p_event_id: event.id, p_user_id: session.user.id });
    if (error) throw error;
    const result = String(data);
    if (!(result in RESULTS)) throw new Error(`unexpected rsvp result ${result}`);
    if (RESULTS[result]) return fail(res, RESULTS[result][0], RESULTS[result][1]);
    if (result === 'ok') await audit(req, { action: 'rsvp.going', actorId: session.user.id, eventId: event.id });
  } else if (body.going === false) {
    const { error } = await db().from(T.attendees).delete().eq('event_id', event.id).eq('user_id', session.user.id);
    if (error) throw error;
    await audit(req, { action: 'rsvp.cancelled', actorId: session.user.id, eventId: event.id });
  } else {
    return fail(res, 400, 'bad_request');
  }

  // Read it again, so the count and spaces left are current.
  const fresh = await releasedEventBySlug(event.slug);
  ok(res, {
    going: body.going === true,
    event: publicEventDetail(fresh ?? event, {
      signedIn: true,
      going: body.going === true,
      canManage: canManage(session.user),
    }),
  });
});
