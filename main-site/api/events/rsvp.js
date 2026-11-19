// POST /api/events/rsvp  { slug, going: true | false, meals?: [id], volunteer?: true | false }
//
// RSVP for a signed-in person (a session that passed the second factor).
// meals: when the event offers meals people can come to on their own, the
// ones this person is coming for instead of the whole event (empty or left
// out: the whole event). Sending going: true again with another choice
// changes it; after RSVPs close, someone going can still change their meals
// but not take one of the event's spaces (migrations/010).
// volunteer: for a convention taking volunteers, whether this person signs
// up to volunteer (migrations/012); left out, it stays as it was. Someone
// going can change it until the event is over, even after RSVPs close.
// Joining goes through the gftvevents_rsvp database function, which locks the
// event row, so two people cannot both take the last space. Only released,
// open, not-yet-over events can be joined; anything else answers the same
// way as a missing event.
//
// -> { event } as the person now sees it (event.viewer.going says whether
// they are going, event.viewer.meals what for, event.viewer.rsvpNumber
// their RSVP ID for the event: the next number up when they join, kept
// while they change their meals, migrations/013).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canManage } from '../_lib/users.js';
import { releasedEventBySlug, withMealCounts, withVolunteerSource, attendance, volunteerStanding } from '../_lib/events.js';
import { chooseMeals, takesVolunteers } from '../_lib/event-rules.js';
import { publicEventDetail } from '../_lib/serialize.js';

// What the gftvevents_rsvp database function can answer: null for a place
// taken (now or before), or the status and error code to refuse with.
const RESULTS = {
  ok: null,
  already: null,
  changed: null,
  not_found: [404, 'not_found'],
  rsvp_closed: [409, 'rsvp_closed'],
  event_full: [409, 'event_full'],
  meal_full: [409, 'meal_full'],
  event_over: [409, 'event_over'],
};

// Signs someone going up to volunteer, or takes them off (volunteer true or
// false), once their RSVP has gone through. Returns whether it changed.
async function setVolunteer(eventId, userId, volunteer) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .update({ volunteer })
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .neq('volunteer', volunteer)
    .select('volunteer');
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return false;
  }
  return data.length > 0;
}

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

  if (body.volunteer !== undefined && typeof body.volunteer !== 'boolean') {
    return fail(response, 400, 'bad_request');
  }
  let meals = [];
  if (body.going === true) {
    const choice = chooseMeals(event, body.meals);
    if (!choice.ok) {
      return fail(response, 400, 'meal_not_offered');
    }
    if (body.volunteer === true && !takesVolunteers(event)) {
      return fail(response, 400, 'volunteers_not_wanted');
    }
    meals = choice.meals;
    const { data, error } = await database().rpc('gftvevents_rsvp', { p_event_id: event.id, p_user_id: session.user.id, p_meals: meals });
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
    let volunteerChanged = false;
    if (typeof body.volunteer === 'boolean') {
      volunteerChanged = await setVolunteer(event.id, session.user.id, body.volunteer);
    }
    if (result === 'ok') {
      await audit(request, { action: 'rsvp.going', actorId: session.user.id, eventId: event.id, details: { meals, volunteer: body.volunteer === true } });
    }
    if (result === 'changed') {
      await audit(request, { action: 'rsvp.meals_changed', actorId: session.user.id, eventId: event.id, details: { meals } });
    }
    if (volunteerChanged && result !== 'ok') {
      await audit(request, { action: 'rsvp.volunteer_changed', actorId: session.user.id, eventId: event.id, details: { volunteer: body.volunteer } });
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
  await withMealCounts(shown);
  await withVolunteerSource(shown);
  const mine = await attendance(event.id, session.user.id);
  const standing = await volunteerStanding(shown, session.user.id);
  ok(response, {
    event: publicEventDetail(shown, {
      signedIn: true,
      going: body.going === true,
      meals,
      rsvpNumber: mine.rsvpNumber,
      canManage: canManage(session.user),
      volunteer: mine.volunteer,
      volunteered: standing.volunteered,
      discount: standing.discount,
    }),
  });
});
