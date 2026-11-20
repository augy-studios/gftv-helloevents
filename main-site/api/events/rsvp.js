// POST /api/events/rsvp  { slug, going: true | false, meals?: [id], volunteer?: true | false,
//                          payment?: { method, tier?, tierName? } }
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
// payment: for an event that takes payment online (migrations/016,
// event-rules.js needsCheckout), what the checkout page sends to get a
// ticket for the whole event: the method picked (one the event offers) and,
// for an event with ticket tiers, the tier's place in the list and its name.
// A ticket paid by link or QR code takes a space at once and waits for
// payment ("awaiting"); one paid on the day is a plain RSVP. The amount is
// worked out here, with any volunteer benefit, never taken from the page.
// Someone going just for a meal pays nothing; someone already going keeps
// the payment they have.
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
import { chooseMeals, takesVolunteers, needsCheckout, paymentOptions, ticketPrice, ONLINE_METHODS } from '../_lib/event-rules.js';
import { publicEventDetail } from '../_lib/serialize.js';
import { deletePaymentFiles } from '../_lib/payments.js';

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

// The payment columns that say there is none.
const NO_PAYMENT = {
  payment_method: null,
  payment_status: 'none',
  payment_tier: null,
  payment_amount: null,
  payment_currency: null,
  payment_reference: null,
  payment_proof_path: null,
  payment_submitted_at: null,
  paid_at: null,
  paid_by: null,
};

// The ticket a checkout asks for: { ok: true, columns } with the attendee
// payment columns to write, or { ok: false, error }. event: after
// withVolunteerSource, for the benefit.
async function checkoutTicket(event, userId, payment) {
  if (!payment || typeof payment !== 'object' || !paymentOptions(event).includes(payment.method)) {
    return { ok: false, error: 'payment_method_required' };
  }
  let tierIndex = null;
  if (Number.isInteger(payment.tier)) {
    tierIndex = payment.tier;
  }
  let tierName = null;
  if (typeof payment.tierName === 'string') {
    tierName = payment.tierName;
  }
  const standing = await volunteerStanding(event, userId);
  const priced = ticketPrice(event, { tierIndex, tierName, volunteerDiscount: standing.discount });
  if (!priced.ok) {
    return priced;
  }
  let status = 'none';
  if (ONLINE_METHODS.includes(payment.method)) {
    status = 'awaiting';
  }
  return {
    ok: true,
    columns: {
      ...NO_PAYMENT,
      payment_method: payment.method,
      payment_status: status,
      payment_tier: priced.tier,
      payment_amount: priced.amount,
      payment_currency: event.currency,
    },
  };
}

async function writePayment(eventId, userId, columns) {
  const { error } = await database()
    .from(TABLES.attendees)
    .update(columns)
    .eq('event_id', eventId)
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
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
  // A cross-border event (migrations/015) takes a new RSVP only from someone
  // with a country of origin on their account; someone already going can
  // still change their meals or take it back.
  if (body.going === true && event.cross_border === true && !session.user.country) {
    const already = await attendance(event.id, session.user.id);
    if (!already.going) {
      return fail(response, 400, 'country_required');
    }
  }
  if (body.going === true) {
    const choice = chooseMeals(event, body.meals);
    if (!choice.ok) {
      return fail(response, 400, 'meal_not_offered');
    }
    if (body.volunteer === true && !takesVolunteers(event)) {
      return fail(response, 400, 'volunteers_not_wanted');
    }
    meals = choice.meals;
    // A ticket for the whole event, at an event taking payment online, by
    // someone not already holding one: it needs a method and a tier.
    const before = await attendance(event.id, session.user.id);
    let ticket = null;
    let heldWholeEvent = false;
    if (before.going && before.meals.length === 0) {
      heldWholeEvent = true;
    }
    if (meals.length === 0 && !heldWholeEvent && needsCheckout(event)) {
      await withVolunteerSource(event);
      ticket = await checkoutTicket(event, session.user.id, body.payment);
      if (!ticket.ok) {
        return fail(response, 400, ticket.error);
      }
    }
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
    if (ticket && (result === 'ok' || result === 'changed')) {
      await writePayment(event.id, session.user.id, ticket.columns);
    }
    // From the whole event to just meals: a payment not yet confirmed is
    // dropped, screenshot and all. A confirmed one is kept for the editors
    // (any refund is between the person and the organisers).
    if (result === 'changed' && meals.length > 0 && before.payment && ['awaiting', 'submitted'].includes(before.payment.payment_status)) {
      await writePayment(event.id, session.user.id, NO_PAYMENT);
      await deletePaymentFiles([before.payment.payment_proof_path]);
    }
    let volunteerChanged = false;
    if (typeof body.volunteer === 'boolean') {
      volunteerChanged = await setVolunteer(event.id, session.user.id, body.volunteer);
    }
    if (result === 'ok') {
      const details = { meals, volunteer: body.volunteer === true };
      if (ticket) {
        details.payment = { method: ticket.columns.payment_method, tier: ticket.columns.payment_tier, amount: ticket.columns.payment_amount };
      }
      await audit(request, { action: 'rsvp.going', actorId: session.user.id, eventId: event.id, details });
    }
    if (result === 'changed') {
      await audit(request, { action: 'rsvp.meals_changed', actorId: session.user.id, eventId: event.id, details: { meals } });
    }
    if (volunteerChanged && result !== 'ok') {
      await audit(request, { action: 'rsvp.volunteer_changed', actorId: session.user.id, eventId: event.id, details: { volunteer: body.volunteer } });
    }
  } else if (body.going === false) {
    const before = await attendance(event.id, session.user.id);
    const { error } = await database()
      .from(TABLES.attendees)
      .delete()
      .eq('event_id', event.id)
      .eq('user_id', session.user.id);
    if (error) {
      throw error;
    }
    if (before.payment) {
      await deletePaymentFiles([before.payment.payment_proof_path]);
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
      country: session.user.country,
      payment: mine.payment,
    }),
  });
});
