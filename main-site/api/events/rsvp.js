// POST /api/events/rsvp  { slug, going?: true | false, meals?: [id], volunteer?: true | false,
//                          lepak?: true | false, fursuiter?: true | false,
//                          payment?: { method, items? },
//                          contact?: { field id: value },
//                          registration?: { question id: answer } }
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
// fursuiter: for an event asking whether people are fursuiters
// (migrations/023), whether this person is one; left out, it stays as it
// was. Like volunteer, someone going can change it until the event is over.
// lepak: "Just Lepak Only" (migrations/017), coming to a paid event without
// a ticket, with meals if they like (meals then names them). It takes none
// of the event's spaces, only one of its lepak places when it caps them.
// Left out, it is false: the whole event, or just meals.
// payment: for an event that takes payment online (migrations/016,
// event-rules.js needsCheckout), what the checkout page sends to get a
// ticket for the whole event: the method picked (one the event offers) and,
// for an event with ticket tiers, the tier bought: items, one { tier: its
// place in the list, tierName, quantity }, more than one of it only as far
// as the tier allows (event-rules.js basketPrice). One tier per person:
// more than one is refused with one_tier_only. The method must suit them all together
// (basketOptions). A page from before sends { tier, tierName } for one.
// A ticket paid by link or QR code takes a space at once and waits for
// payment ("awaiting"); one paid on the day is a plain RSVP. The amount is
// worked out here, with any volunteer benefit, never taken from the page.
// Someone going just for a meal pays nothing; someone already going keeps
// the payment they have.
// contact: the contact details the event asks for (migrations/021,
// js/contact-fields.js), by field id. Joining needs them as the event's
// rule says (at least one, all, or none); someone already going can send
// them with a change, or on their own with going left out, to fill them in
// or change them. Left out, they stay as they were. Refused with
// contact_required or contact_invalid, and the field's id when one is to
// blame.
// registration: answers to the event's registration form (migrations/024,
// js/registration-fields.js), by question id. Joining needs every required
// one, and the account details the form requires (refused with
// account_details_required and the missing ones in fields). Someone going
// can send just the answers they change (with going left out), merged over
// what they gave, while registration is open for them: RSVPs open, the
// event not over, and none of their tiers closed (refused with
// registration_closed). A donation is added to a checkout ticket's total,
// and is fixed once the order holds it. A photo answer is the name
// api/events/registration-photo.js gave back. "Are you fursuiting?" sets
// the fursuiter flag too. Refused with registration_required or
// registration_invalid, and the question's id.
// Joining goes through the gftvevents_rsvp database function, which locks the
// event row, so two people cannot both take the last space (or a tier's
// last place, migrations/025: refused with tier_full). Only released,
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
import { canEditEvent } from '../_lib/event-editors.js';
import { releasedEventBySlug, withMealCounts, withVolunteerSource, attendance, volunteerStanding } from '../_lib/events.js';
import { chooseMeals, takesVolunteers, asksFursuiters, needsCheckout, paymentOptions, sellsTiers, basketPrice, basketOptions, ticketPrice, lepakOffered, registrationOpenFor, donationOf, heldTiers, registrationFieldsFor, ONLINE_METHODS } from '../_lib/event-rules.js';
import { publicEventDetail } from '../_lib/serialize.js';
import { withGallery } from '../_lib/gallery.js';
import { withDescriptionPictures } from '../_lib/description-pictures.js';
import { deletePaymentFiles, registrationPhotoExists, registrationPhotoPath } from '../_lib/payments.js';
import { readRegistrationAnswers, missingAccountDetails, registrationAsksFursuiting, photoNames } from '../../js/registration-fields.js';
import { storedContactFields, storedContactRule, readContactAnswers } from '../../js/contact-fields.js';

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
  tier_full: [409, 'tier_full'],
  lepak_full: [409, 'lepak_full'],
  lepak_not_offered: [400, 'lepak_not_offered'],
  event_over: [409, 'event_over'],
};

// Sets one of someone's yes-or-no answers once their RSVP has gone through:
// volunteer (signed up to volunteer) or fursuiter. Returns whether it
// changed.
async function setAnswer(eventId, userId, column, value) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .update({ [column]: value })
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .neq(column, value)
    .select(column);
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
  payment_credit: null,
  payment_method: null,
  payment_status: 'none',
  payment_tier: null,
  payment_items: null,
  payment_amount: null,
  payment_currency: null,
  payment_reference: null,
  payment_proof_path: null,
  payment_submitted_at: null,
  paid_at: null,
  paid_by: null,
};

// The tiers a checkout asks for, as sent: a basket (items), or the one tier
// a page from before baskets sends.
function wantedItems(payment) {
  if (payment.items === undefined && Number.isInteger(payment.tier)) {
    return [{ tier: payment.tier, tierName: payment.tierName, quantity: 1 }];
  }
  return payment.items;
}

// The tiers a ticket about to be bought is for (storedTiers entries), for
// the registration questions their holders are asked; none when the basket
// is not one that can be bought (checkoutTicket then says why).
function buyingTiers(event, payment) {
  if (!sellsTiers(event) || !payment || typeof payment !== 'object') {
    return [];
  }
  const priced = basketPrice(event, wantedItems(payment));
  if (!priced.ok) {
    return [];
  }
  return priced.tiers;
}

// The ticket a checkout asks for: { ok: true, columns } with the attendee
// payment columns to write, or { ok: false, error }. event: after
// withVolunteerSource, for the benefit.
async function checkoutTicket(event, userId, payment, donation = 0) {
  if (!payment || typeof payment !== 'object' || !paymentOptions(event).includes(payment.method)) {
    return { ok: false, error: 'payment_method_required' };
  }
  const standing = await volunteerStanding(event, userId);
  let priced;
  let options = paymentOptions(event);
  let tierText = null;
  let items = null;
  if (sellsTiers(event)) {
    priced = basketPrice(event, wantedItems(payment), { volunteerDiscount: standing.discount });
    if (!priced.ok) {
      return priced;
    }
    // Tiers can take their own ways to pay; together, the ways they share.
    options = basketOptions(event, priced.tiers);
    if (options.length === 0) {
      return { ok: false, error: 'tiers_not_together' };
    }
    tierText = priced.text;
    items = priced.items;
  } else {
    priced = ticketPrice(event, { volunteerDiscount: standing.discount });
    if (!priced.ok) {
      return priced;
    }
  }
  if (!options.includes(payment.method)) {
    return { ok: false, error: 'payment_method_required' };
  }
  let status = 'none';
  if (ONLINE_METHODS.includes(payment.method)) {
    status = 'awaiting';
  }
  // The donation from the registration form comes on top (migrations/024).
  const amount = Math.round((priced.amount + donation) * 100) / 100;
  return {
    ok: true,
    columns: {
      ...NO_PAYMENT,
      payment_method: payment.method,
      payment_status: status,
      payment_tier: tierText,
      payment_items: items,
      payment_amount: amount,
      // The tier's own currency, or the event's (per-tier currencies).
      payment_currency: priced.currency,
    },
  };
}

// The contact details sent, checked against the event's fields and rule:
// { ok: true, contact } or { ok: false, error, field }.
function checkContact(event, given) {
  return readContactAnswers(storedContactFields(event), storedContactRule(event), given);
}

function contactRefusal(response, check) {
  const extra = {};
  if (check.field) {
    extra.field = check.field;
  }
  return fail(response, 400, check.error, extra);
}

async function writeContact(eventId, userId, contact) {
  const { error } = await database()
    .from(TABLES.attendees)
    .update({ contact })
    .eq('event_id', eventId)
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
}

// The registration answers sent, checked against the questions this person
// is asked (fields: event-rules.js registrationFieldsFor, by the tiers
// their ticket is for) and merged over the ones given before (previous):
// { ok: true, answers } (null when they are asked none) or { ok: false,
// error, field }. stored: the person's attendee row while going; once it
// holds an order, its donation stays as it is.
async function checkRegistration(event, userId, fields, given, previous, stored) {
  if (fields.length === 0) {
    return { ok: true, answers: null };
  }
  let input = {};
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    input = { ...given };
  }
  if (stored && stored.payment_method) {
    delete input.donation;
  }
  const read = readRegistrationAnswers(fields, input, previous);
  if (!read.ok) {
    return read;
  }
  // A new photo has to be one this person stored for this event.
  for (const field of fields) {
    const name = read.answers[field.id];
    if (field.type === 'photo' && name && name !== previous[field.id]) {
      if (!(await registrationPhotoExists(event.id, userId, name))) {
        return { ok: false, error: 'registration_invalid', field: field.id };
      }
    }
  }
  return read;
}

function registrationRefusal(response, check) {
  const extra = {};
  if (check.field) {
    extra.field = check.field;
  }
  return fail(response, 400, check.error, extra);
}

// Saves the answers, with "Are you fursuiting?" in the fursuiter flag too,
// and deletes any photo they replaced.
async function writeRegistration(event, userId, answers, previous) {
  const columns = { registration: answers };
  if (registrationAsksFursuiting(event) && answers.fursuiting) {
    columns.fursuiter = answers.fursuiting === 'yes';
  }
  const { error } = await database()
    .from(TABLES.attendees)
    .update(columns)
    .eq('event_id', event.id)
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
  const kept = new Set(photoNames(answers));
  const gone = photoNames(previous).filter((name) => !kept.has(name));
  await deletePaymentFiles(gone.map((name) => registrationPhotoPath(event.id, userId, name)));
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
  if (body.fursuiter !== undefined && typeof body.fursuiter !== 'boolean') {
    return fail(response, 400, 'bad_request');
  }
  if (body.contact !== undefined && (body.contact === null || typeof body.contact !== 'object' || Array.isArray(body.contact))) {
    return fail(response, 400, 'bad_request');
  }
  let contactSent = null;
  let registrationSent = null;
  if (body.registration !== undefined && (body.registration === null || typeof body.registration !== 'object' || Array.isArray(body.registration))) {
    return fail(response, 400, 'bad_request');
  }
  let meals = [];
  let lepak = false;
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
    if (body.fursuiter === true && !asksFursuiters(event)) {
      return fail(response, 400, 'fursuiters_not_asked');
    }
    meals = choice.meals;
    if (body.lepak !== undefined && typeof body.lepak !== 'boolean') {
      return fail(response, 400, 'bad_request');
    }
    lepak = body.lepak === true;
    if (lepak && !lepakOffered(event)) {
      return fail(response, 400, 'lepak_not_offered');
    }
    // A ticket for the whole event, at an event taking payment online, by
    // someone not already holding one: it needs a method and a tier.
    const before = await attendance(event.id, session.user.id);
    let heldWholeEvent = false;
    if (before.going && before.meals.length === 0 && !before.lepak) {
      heldWholeEvent = true;
    }
    let buying = false;
    if (meals.length === 0 && !lepak && !heldWholeEvent && needsCheckout(event)) {
      buying = true;
    }
    // The registration questions this person is asked: those for the tiers
    // they are buying now, or hold.
    let tiers = [];
    if (buying) {
      tiers = buyingTiers(event, body.payment);
    } else if (before.going) {
      tiers = heldTiers(event, before.payment);
    }
    const asked = registrationFieldsFor(event, tiers);
    // Contact details: needed to join; sent with a change, checked too.
    if (!before.going || body.contact !== undefined) {
      const check = checkContact(event, body.contact);
      if (!check.ok) {
        return contactRefusal(response, check);
      }
      contactSent = check.contact;
    }
    // The registration form (migrations/024): needed to join, with the
    // account details it requires; a change only while it is open.
    if (!before.going) {
      const missing = missingAccountDetails(asked, session.user.personal);
      if (missing.length > 0) {
        return fail(response, 400, 'account_details_required', { fields: missing });
      }
    }
    if (before.going && body.registration !== undefined && !registrationOpenFor(event, before.payment)) {
      return fail(response, 409, 'registration_closed');
    }
    if (!before.going || body.registration !== undefined) {
      let previous = {};
      if (before.going) {
        previous = before.registration;
      }
      const check = await checkRegistration(event, session.user.id, asked, body.registration, previous, before.payment);
      if (!check.ok) {
        return registrationRefusal(response, check);
      }
      registrationSent = check.answers;
    }
    let ticket = null;
    if (buying) {
      await withVolunteerSource(event);
      let answers = before.registration;
      if (registrationSent !== null) {
        answers = registrationSent;
      }
      ticket = await checkoutTicket(event, session.user.id, body.payment, donationOf(event, answers));
      if (!ticket.ok) {
        return fail(response, 400, ticket.error);
      }
    }
    // The tiers bought go in with the place, so the database can hold each
    // tier to its limit (migrations/025) under the same lock.
    const rsvpArgs = { p_event_id: event.id, p_user_id: session.user.id, p_meals: meals, p_lepak: lepak };
    if (ticket && Array.isArray(ticket.columns.payment_items)) {
      rsvpArgs.p_items = ticket.columns.payment_items;
    }
    const { data, error } = await database().rpc('gftvevents_rsvp', rsvpArgs);
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
    if (contactSent !== null) {
      await writeContact(event.id, session.user.id, contactSent);
    }
    if (registrationSent !== null) {
      await writeRegistration(event, session.user.id, registrationSent, before.registration);
    }
    // From the whole event to just meals or lepak: a payment not yet
    // confirmed is dropped, screenshot and all. A confirmed one is kept for
    // the editors (any refund is between the person and the organisers).
    let leftTicket = lepak;
    if (meals.length > 0) {
      leftTicket = true;
    }
    if (result === 'changed' && leftTicket && before.payment && ['awaiting', 'submitted'].includes(before.payment.payment_status)) {
      await writePayment(event.id, session.user.id, NO_PAYMENT);
      await deletePaymentFiles([before.payment.payment_proof_path]);
    }
    let volunteerChanged = false;
    if (typeof body.volunteer === 'boolean') {
      volunteerChanged = await setAnswer(event.id, session.user.id, 'volunteer', body.volunteer);
    }
    let fursuiterChanged = false;
    if (typeof body.fursuiter === 'boolean') {
      fursuiterChanged = await setAnswer(event.id, session.user.id, 'fursuiter', body.fursuiter);
    }
    if (result === 'ok') {
      const details = { meals, lepak, volunteer: body.volunteer === true, fursuiter: body.fursuiter === true };
      if (ticket) {
        details.payment = { method: ticket.columns.payment_method, tier: ticket.columns.payment_tier, items: ticket.columns.payment_items, amount: ticket.columns.payment_amount };
      }
      await audit(request, { action: 'rsvp.going', actorId: session.user.id, eventId: event.id, details });
    }
    if (result === 'changed') {
      await audit(request, { action: 'rsvp.meals_changed', actorId: session.user.id, eventId: event.id, details: { meals, lepak } });
    }
    if (volunteerChanged && result !== 'ok') {
      await audit(request, { action: 'rsvp.volunteer_changed', actorId: session.user.id, eventId: event.id, details: { volunteer: body.volunteer } });
    }
    if (fursuiterChanged && result !== 'ok') {
      await audit(request, { action: 'rsvp.fursuiter_changed', actorId: session.user.id, eventId: event.id, details: { fursuiter: body.fursuiter } });
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
      const photos = photoNames(before.registration).map((name) => registrationPhotoPath(event.id, session.user.id, name));
      await deletePaymentFiles([before.payment.payment_proof_path, ...photos]);
    }
    await audit(request, { action: 'rsvp.cancelled', actorId: session.user.id, eventId: event.id });
  } else if (body.going === undefined && (body.contact !== undefined || body.registration !== undefined)) {
    // Just the contact details or registration answers, from someone going.
    const before = await attendance(event.id, session.user.id);
    if (!before.going) {
      return fail(response, 409, 'not_going');
    }
    let contact = null;
    if (body.contact !== undefined) {
      const check = checkContact(event, body.contact);
      if (!check.ok) {
        return contactRefusal(response, check);
      }
      contact = check.contact;
    }
    let answers = null;
    if (body.registration !== undefined) {
      if (!registrationOpenFor(event, before.payment)) {
        return fail(response, 409, 'registration_closed');
      }
      const asked = registrationFieldsFor(event, heldTiers(event, before.payment));
      const check = await checkRegistration(event, session.user.id, asked, body.registration, before.registration, before.payment);
      if (!check.ok) {
        return registrationRefusal(response, check);
      }
      answers = check.answers;
    }
    if (contact !== null) {
      await writeContact(event.id, session.user.id, contact);
      await audit(request, { action: 'rsvp.contact_changed', actorId: session.user.id, eventId: event.id, details: { fields: Object.keys(contact) } });
    }
    if (answers !== null) {
      await writeRegistration(event, session.user.id, answers, before.registration);
      await audit(request, { action: 'rsvp.registration_changed', actorId: session.user.id, eventId: event.id, details: { questions: Object.keys(body.registration) } });
    }
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
  await withGallery(shown);
  await withDescriptionPictures(shown);
  const mine = await attendance(event.id, session.user.id);
  const standing = await volunteerStanding(shown, session.user.id);
  ok(response, {
    event: publicEventDetail(shown, {
      signedIn: true,
      going: mine.going,
      meals: mine.meals,
      lepak: mine.lepak,
      rsvpNumber: mine.rsvpNumber,
      canManage: await canEditEvent(session.user, shown.id),
      volunteer: mine.volunteer,
      fursuiter: mine.fursuiter,
      volunteered: standing.volunteered,
      discount: standing.discount,
      country: session.user.country,
      payment: mine.payment,
      contact: mine.contact,
      registration: mine.registration,
      personal: session.user.personal,
    }),
  });
});
