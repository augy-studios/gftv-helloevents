// GET /api/events/checkout?slug=<slug>   -> { checkout }
//
// The checkout page (/checkout?slug=..., migrations/016) for someone signed
// in: the tickets and what each costs them, the ways to pay, and their own
// place and payment (serialize.js checkoutView). Released events only, or
// any event for an editor; anything else answers 404, as the event page
// does.

import { route, guard, ok, fail, query } from '../_lib/http.js';
import { requireUser } from '../_lib/session.js';
import { canManage } from '../_lib/users.js';
import { releasedEventBySlug, anyEventBySlug, attendance, withVolunteerSource, withTierCounts, volunteerStanding, contactSuggestion, eventAsksContact, DETAIL_COLUMNS } from '../_lib/events.js';
import { checkoutView } from '../_lib/serialize.js';

// The event for this person to check out from, or null.
export async function checkoutEvent(slug, user) {
  if (canManage(user)) {
    return anyEventBySlug(slug, DETAIL_COLUMNS);
  }
  return releasedEventBySlug(slug);
}

// The checkout page's answer for this person and event.
export async function checkoutAnswer(row, user) {
  await withVolunteerSource(row);
  await withTierCounts(row);
  const mine = await attendance(row.id, user.id);
  const standing = await volunteerStanding(row, user.id);
  let contactSuggest = {};
  if (!mine.going && eventAsksContact(row)) {
    contactSuggest = await contactSuggestion(user.id);
  }
  return checkoutView(row, {
    going: mine.going,
    meals: mine.meals,
    lepak: mine.lepak,
    rsvpNumber: mine.rsvpNumber,
    volunteer: mine.volunteer,
    fursuiter: mine.fursuiter,
    discount: standing.discount,
    country: user.country,
    payment: mine.payment,
    contact: mine.contact,
    contactSuggest,
    registration: mine.registration,
    personal: user.personal,
    idVerified: user.idVerified,
    helloidPending: user.helloidPending,
  });
}

export default route('events/checkout', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const row = await checkoutEvent(query(request, 'slug').toLowerCase(), session.user);
  if (!row) {
    return fail(response, 404, 'not_found');
  }
  ok(response, { checkout: await checkoutAnswer(row, session.user) });
});
