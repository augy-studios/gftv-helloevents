// What leaves the server, decided field by field (server-side data
// minimisation, help desk #7).
//
// No route sends a database row as it came back: every response body is built
// here from an explicit list of fields for that caller, so a column added to
// a table later is never published by accident. In particular:
//
//   Unreleased events (drafts, or published with a release time still in the
//   future) are never serialised for the public at all; the public queries
//   filter them out in the database (event-rules.js releasedFilter).
//   Dates marked "to be announced" go out as { tba: true }, without the
//   stored start and end.
//   A hidden price goes out as { type: "tba" }, without the stored amounts.
//   An address marked attendees-only, and the online link, go only to people
//   who are going, and to editors.
//   Staff notes, who created or edited an event, and attendee identities go
//   only to editors, and an attendee is a display name and username, never
//   an email.
//   Pictures (covers, staff profile pictures) go out as this site's own
//   addresses (api/events/cover.js, api/me/avatar.js), never the Supabase
//   Storage address they are kept at.
//   A timetable goes out only while the dates are announced, since its days
//   would give them away.
//   On a cross-border event (migrations/015), the link goes only to people
//   signed in with a country of origin, and to editors; an attendee's
//   country goes only to editors, and only for a cross-border event.
//   Registration answers and photos (migrations/024) go only to the person
//   and the event's editors; of the account's personal details, editors get
//   only those the event's form asks for, a date of birth as the age at the
//   event unless the form asks for the full date.
//   Whether someone signed up to volunteer, or volunteered, goes only to
//   them and to editors (migrations/012); the public page says only whether
//   a convention takes volunteers and what its volunteer benefit is.
//   Password hashes, TOTP secrets, code and token hashes, Telegram chat ids,
//   emails, notification choices of other people and IP hashes have no
//   serializer at all, so they cannot reach a browser. Public accounts are
//   held to exactly the same lists as staff ones.
//
// And each answer carries only what the page that asks for it shows, plus
// the ids its buttons send back (help desk #18): nothing a page never reads,
// even about the person themselves. tests/response-keys.test.js pins every
// answer's exact keys.
//
// Each answer field is written next to the database column it comes from,
// as `answerField: row.database_column`, through one of the small helpers
// below when the column needs a default.

import { isOver, isReleased, datesAnnounced, utcToWall, storedLocations, storedMeals, storedTiers, takesVolunteers, volunteerDiscountActive, storedTimetable, itemTimes, LINK_LABELS, paymentOptions, needsCheckout, paymentProblems, ticketPrice, PAYMENT_METHODS, lepakOffered, lepakLabel, lepakLimit, asksFursuiters, fursuiterTickShown, tierClosed, tierLeft, tierCurrency, registrationOpenFor, upgradeOptions, paidSoFar, donationOf, tierOptions, heldTiers, ticketOptions, includedTiers, tierLink, tierQrPath, sellsTiers, tieredRegistrationFields, heldRegistrationFields, questionTierPlaces } from './event-rules.js';
import { roleOf, canManage, avatarSource } from './users.js';
import { sha256 } from './crypto.js';
import { coverUrl } from './covers.js';
import { galleryImageUrl } from './gallery.js';
import { displayDescription } from './rich-text.js';
import { storedContactFields, storedContactRule, storedContact, contactComplete } from '../../js/contact-fields.js';
import { qrUrl } from './payments.js';
import { configuredRegistrationFields, storedAnswers, answersComplete, missingAccountDetails, ageOn } from '../../js/registration-fields.js';

// ---------------------------------------------------------------------------
// Defaults
//
// "Empty" means any false-like value: null, undefined, '', 0, false or NaN.
// "Missing" means null or undefined only, so a 0 or '' is kept as it is.
// ---------------------------------------------------------------------------

// The value, or null when it is empty.
function emptyToNull(value) {
  if (value) {
    return value;
  }
  return null;
}

// The value, or '' when it is empty: a blank form field.
function emptyToBlank(value) {
  if (value) {
    return value;
  }
  return '';
}

// The value, or null when it is missing.
function missingToNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return value;
}

// The value as a number, or null when it is missing.
function numberOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

// The value as a string, or '' when it is missing: a form field.
function stringOrBlank(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// The value as a number, or 0 when that is not a number.
function numberOrZero(value) {
  const number = Number(value);
  if (number) {
    return number;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// The signed-in person, about themselves. Their own notification choices are
// theirs to see; the email is not sent even to them (nothing here needs it).
// editsEvents: whether they edit any event, staff or an editor of one
// (event-editors.js editsAnyEvent), for the Manage link and page.
export function selfView(user, { editsEvents = false } = {}) {
  let displayName = user.display_name;
  if (!displayName) {
    displayName = user.username;
  }
  // The picture is served from this site (api/me/avatar.js), so its Storage
  // address never goes out; v changes with the picture. Only one stored in
  // this site's Supabase project is shown.
  let avatarUrl = null;
  const source = avatarSource(user);
  if (source) {
    avatarUrl = `/api/me/avatar?v=${sha256(source).slice(0, 12)}`;
  }
  let kind = 'staff';
  if (user.kind === 'public') {
    kind = 'public';
  }
  return {
    username: user.username,
    displayName,
    avatarUrl,
    kind,
    role: roleOf(user),
    canManage: canManage(user),
    editsEvents: editsEvents === true,
    country: missingToNull(user.country),
    // Personal details (migrations/024), theirs to see and fill in on the
    // Profile tab: the legal name, date of birth and country are locked
    // once set.
    personal: selfPersonal(user.personal),
  };
}

function selfPersonal(personal) {
  let given = personal;
  if (given === null || given === undefined) {
    given = {};
  }
  return {
    legalName: missingToNull(given.legalName),
    dateOfBirth: missingToNull(given.dateOfBirth),
    emergencyName: missingToNull(given.emergencyName),
    emergencyPhone: missingToNull(given.emergencyPhone),
  };
}

// An attendee, for an editor's attendee list: a name, a username, whether
// it is a staff or a public account, the meals they are coming for (empty
// for the whole event), and their volunteering (migrations/012): signed up
// to volunteer here, confirmed as having volunteered here, and confirmed at
// the earlier convention this event's volunteer benefit is for (so they get
// it). Never an email or an id.
// row: { created_at, meals, volunteer, account: { kind, username, display_name, staff: {...} } }
// event: the event's row, for the meals it still offers.
// standing: { volunteered, pastVolunteer }, looked up by the caller.
// rsvpNumber is their RSVP ID for this event (migrations/013).
export function attendeeView(row, event = {}, standing = {}) {
  let account = row.account;
  if (account === null || account === undefined) {
    account = {};
  }
  const isStaff = account.kind === 'staff';
  // A staff account's names are on its gftvhello_users record.
  let person = account;
  if (isStaff) {
    person = account.staff;
    if (person === null || person === undefined) {
      person = {};
    }
  }
  let displayName = person.display_name;
  if (!displayName) {
    displayName = person.username;
  }
  if (!displayName) {
    displayName = null;
  }
  return {
    rsvpNumber: missingToNull(row.rsvp_number),
    username: missingToNull(person.username),
    displayName,
    staff: isStaff,
    meals: offeredMeals(event, row.meals),
    lepak: row.lepak === true,
    country: attendeeCountry(event, account),
    volunteer: row.volunteer === true,
    fursuiter: attendeeFursuiter(event, row),
    volunteered: standing.volunteered === true,
    pastVolunteer: standing.pastVolunteer === true,
    payment: attendeePayment(row),
    contact: attendeeContact(event, row.contact),
    registration: attendeeRegistration(event, row, person, isStaff),
    personal: attendeePersonal(event, row, account),
    rsvpAt: row.created_at,
  };
}

// The registration answers someone gave (migrations/024), for the event's
// editors: one entry for each question of the form they answered that the
// tiers they hold are asked, in its order; a photo as the address editors
// open it at.
function attendeeRegistration(event, row, person, isStaff) {
  const fields = heldRegistrationFields(event, row).filter((field) => field.type !== 'account');
  const answers = storedAnswers(fields, row.registration);
  return fields
    .filter((field) => answers[field.id] !== undefined)
    .map((field) => {
      let value = answers[field.id];
      let photoUrl = null;
      if (field.type === 'photo') {
        photoUrl = registrationPhotoUrl(event.slug, field.id, value, { username: person.username, staff: isStaff });
        value = null;
      }
      return { id: field.id, type: field.type, label: field.label, value, photoUrl };
    });
}

// Where a registration photo is opened (api/events/registration-photo.js):
// the person's own, or, with who (editors only), an attendee's.
function registrationPhotoUrl(slug, questionId, name, who = null) {
  if (!slug || typeof name !== 'string') {
    return null;
  }
  let url = `/api/events/registration-photo?slug=${encodeURIComponent(slug)}&q=${encodeURIComponent(questionId)}&v=${encodeURIComponent(name)}`;
  if (who && who.username) {
    url = `${url}&u=${encodeURIComponent(who.username)}`;
    if (who.staff) {
      url = `${url}&staff=1`;
    }
  }
  return url;
}

// The day an event starts, in its own zone ('YYYY-MM-DD'), or today.
function eventDay(event) {
  if (event.starts_at && event.timezone) {
    const wall = utcToWall(event.starts_at, event.timezone);
    if (wall) {
      return wall.slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

// The account details an event's form asks for (migrations/024), for its
// editors, and only those: the legal name, the emergency contact, and from
// the date of birth the age on the day the event starts (and whether that
// is under 18), with the date itself only when the form asks for it. null
// for a detail asked but not given; the key is missing when not asked (of
// the tiers they hold).
function attendeePersonal(event, row, account) {
  const fields = heldRegistrationFields(event, row).filter((field) => field.type === 'account');
  if (fields.length === 0) {
    return null;
  }
  const personal = {};
  for (const field of fields) {
    if (field.id === 'legalName') {
      personal.legalName = emptyToNull(account.legal_name);
    }
    if (field.id === 'emergencyContact') {
      personal.emergencyName = emptyToNull(account.emergency_name);
      personal.emergencyPhone = emptyToNull(account.emergency_phone);
    }
    if (field.id === 'dateOfBirth') {
      let born = emptyToNull(account.date_of_birth);
      if (born) {
        born = String(born).slice(0, 10);
      }
      const age = ageOn(born, eventDay(event));
      personal.age = age;
      personal.under18 = false;
      if (age !== null && age < 18) {
        personal.under18 = true;
      }
      if (field.fullDate) {
        personal.dateOfBirth = born;
      }
    }
  }
  return personal;
}

// The registration form (migrations/024), for the event page and checkout:
// its questions (none while it is off), and the currency a donation is in.
// tiers: the places in the tier list (as checkout picks them) of the tiers
// whose holders a question is asked, or null for every ticket.
function registrationView(row) {
  return {
    fields: tieredRegistrationFields(row).map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      hint: field.hint,
      required: field.required,
      options: field.options,
      link: field.link,
      tiers: questionTierPlaces(row, field),
    })),
    currency: emptyToNull(row.currency),
  };
}

// The account details the form asks for, from the viewer's own account,
// for the card and the form to show (their own data): only those asked.
function askedPersonal(fields, personal) {
  const given = {};
  if (!personal) {
    return given;
  }
  for (const field of fields) {
    if (field.id === 'legalName') {
      given.legalName = missingToNull(personal.legalName);
    }
    if (field.id === 'dateOfBirth') {
      given.dateOfBirth = missingToNull(personal.dateOfBirth);
    }
    if (field.id === 'emergencyContact') {
      given.emergencyName = missingToNull(personal.emergencyName);
      given.emergencyPhone = missingToNull(personal.emergencyPhone);
    }
  }
  return given;
}

// This person and the form (migrations/024): their answers (someone going),
// their photos' addresses, whether answers the form needs are missing,
// which account details it needs that their account lacks, the account
// details it asks for, the tier they hold, which questions they are asked
// (asked: ids, by the tiers they hold; null for someone not going, whose
// questions follow the tiers they pick), and whether they can still change
// their answers (registration open for them). Not going, the account
// details are those any ticket's questions need: the page keeps those of
// the tiers picked.
function viewerRegistration(row, viewer, now) {
  let fields = tieredRegistrationFields(row);
  const answers = {};
  const photos = {};
  let missing = false;
  let tier = null;
  let stored = null;
  let asked = null;
  const asksForm = fields.length > 0;
  if (viewer.going === true) {
    if (viewer.payment) {
      stored = viewer.payment;
    }
    fields = heldRegistrationFields(row, stored);
    asked = fields.map((field) => field.id);
    Object.assign(answers, storedAnswers(fields, viewer.registration));
    if (fields.length > 0 && !answersComplete(fields, answers)) {
      missing = true;
    }
    for (const field of fields) {
      if (field.type === 'photo' && answers[field.id]) {
        photos[field.id] = registrationPhotoUrl(row.slug, field.id, answers[field.id]);
      }
    }
    if (stored) {
      tier = missingToNull(stored.payment_tier);
    }
  }
  let open = false;
  if (asksForm && registrationOpenFor(row, stored, now)) {
    open = true;
  }
  return {
    answers,
    photos,
    missing,
    accountMissing: missingAccountDetails(fields, viewer.personal),
    personal: askedPersonal(fields, viewer.personal),
    tier,
    asked,
    open,
  };
}

// Whether someone said they are a fursuiter (migrations/023), shown only
// while the event asks.
function attendeeFursuiter(event, row) {
  if (!asksFursuiters(event)) {
    return false;
  }
  return row.fursuiter === true;
}

// The contact details someone gave (migrations/021), for the event's
// editors: one entry for each of the event's fields they filled in, in the
// event's order.
function attendeeContact(event, raw) {
  const fields = storedContactFields(event);
  const given = storedContact(fields, raw);
  return fields
    .filter((field) => given[field.id] !== undefined)
    .map((field) => ({ id: field.id, type: field.type, label: field.label, value: given[field.id] }));
}

// The contact details asked for (migrations/021), for this person: what
// someone going gave, and whether it is still short of what the event asks
// (it asked after they RSVPed, or asks more now); for anyone else, what to
// fill the form in with (viewer.contactSuggest: their linked Telegram, what
// they gave other events).
function viewerContact(row, viewer) {
  const fields = storedContactFields(row);
  if (viewer.going === true) {
    const myContact = storedContact(fields, viewer.contact);
    return { myContact, contactMissing: !contactComplete(fields, storedContactRule(row), myContact) };
  }
  return { myContact: storedContact(fields, viewer.contactSuggest), contactMissing: false };
}

// The contact details an event asks for, for its page: the fields and the
// rule (js/contact-fields.js); no fields, nothing asked.
function contactView(row) {
  return {
    fields: storedContactFields(row).map((field) => ({ id: field.id, type: field.type, label: field.label })),
    rule: storedContactRule(row),
  };
}

// Where a payment stands (migrations/016): 'awaiting', 'submitted' or
// 'paid', and 'none' for anything else.
function paymentStatusOf(row) {
  if (['awaiting', 'submitted', 'paid'].includes(row.payment_status)) {
    return row.payment_status;
  }
  return 'none';
}

// The payment methods ticked on an event, in their fixed order.
function storedPaymentMethods(row) {
  if (!Array.isArray(row.payment_methods)) {
    return [];
  }
  return PAYMENT_METHODS.filter((method) => row.payment_methods.includes(method));
}

// An attendee's payment, for editors: how they are paying, where it stands,
// the tier and amount asked at checkout, the reference they gave, whether
// there is a screenshot to look at (api/manage/payment-proof.js), and when
// they reported it and when it was confirmed.
function attendeePayment(row) {
  return {
    method: missingToNull(row.payment_method),
    status: paymentStatusOf(row),
    tier: missingToNull(row.payment_tier),
    items: paymentItemsView(row),
    amount: numberOrNull(row.payment_amount),
    currency: missingToNull(row.payment_currency),
    reference: missingToNull(row.payment_reference),
    hasProof: Boolean(row.payment_proof_path),
    submittedAt: missingToNull(row.payment_submitted_at),
    paidAt: missingToNull(row.paid_at),
    // Paid before an upgrade (migrations/024): only the rest is owed.
    credit: paidCredit(row),
  };
}

// An attendee's country of origin, for the editors of a cross-border event
// (migrations/015) only; null for any other event, or while they have none.
function attendeeCountry(event, account) {
  if (event.cross_border !== true) {
    return null;
  }
  return emptyToNull(account.country);
}

// A passkey on the account page: its name, when it was added and when it was
// last used ("Never used" while lastUsedAt is null), and the id the Remove
// button sends.
export function passkeyView(row) {
  return {
    id: row.id,
    label: emptyToNull(row.label),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// A stored time split for the form's date and time inputs, in the event's
// zone: { date: "2026-11-14", time: "14:00" }, the time '' while it is to be
// confirmed, both '' when there is no time.
function dateAndTime(isoTime, timeZone, timeTbc) {
  const wallTime = utcToWall(isoTime, timeZone);
  if (!wallTime) {
    return { date: '', time: '' };
  }
  let time = wallTime.slice(11, 16);
  if (timeTbc) {
    time = '';
  }
  return { date: wallTime.slice(0, 10), time };
}

// The start and end for the edit form. An end the API filled in itself (a
// start with no time and no end lasts its whole day, event-rules.js
// readTimes) goes back blank, as the editor left it.
function managedWhen(row) {
  const start = dateAndTime(row.starts_at, row.timezone, row.start_time_tbc === true);
  let end = dateAndTime(row.ends_at, row.timezone, row.end_time_tbc === true);
  if (row.start_time_tbc === true && row.end_time_tbc === true && end.date === start.date) {
    end = { date: '', time: '' };
  }
  return { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time };
}

// The price. A card shows only the price itself; the event page also shows
// the organiser's note under it, so only the page asks for it (withNote).
function priceView(row, { withNote = false } = {}) {
  if (row.price_hidden || row.price_type === 'tba') {
    return { type: 'tba' };
  }
  let view;
  if (row.price_type === 'free') {
    view = { type: 'free' };
  } else {
    view = {
      type: 'paid',
      min: numberOrNull(row.price_min),
      max: numberOrNull(row.price_max),
      currency: emptyToNull(row.currency),
    };
  }
  if (withNote) {
    view.note = emptyToNull(row.price_note);
  }
  return view;
}

// When: the start and end, and whether each one's time is still to be
// confirmed (then the pages show its date alone).
function whenView(row) {
  if (!datesAnnounced(row)) {
    return { tba: true, timezone: row.timezone };
  }
  return {
    tba: false,
    startsAt: row.starts_at,
    endsAt: emptyToNull(row.ends_at),
    startTimeTbc: row.start_time_tbc === true,
    endTimeTbc: row.end_time_tbc === true,
    timezone: row.timezone,
  };
}

// One location on the event page. addressShown: whether this viewer may see
// the street address and the map link (an attendees-only address keeps
// both from everyone else, since the link gives the place away too).
function locationView(location, addressShown) {
  let address = null;
  let mapsUrl = null;
  if (addressShown) {
    address = emptyToNull(location.venue_address);
    mapsUrl = emptyToNull(location.maps_url);
  }
  return {
    label: location.label,
    customLabel: emptyToNull(location.custom_label),
    venueName: emptyToNull(location.venue_name),
    city: emptyToNull(location.city),
    country: emptyToNull(location.country),
    address,
    mapsUrl,
  };
}

// One location on the edit form, every field a string.
function managedLocation(location) {
  return {
    label: location.label,
    customLabel: emptyToBlank(location.custom_label),
    venueName: emptyToBlank(location.venue_name),
    venueAddress: emptyToBlank(location.venue_address),
    city: emptyToBlank(location.city),
    country: emptyToBlank(location.country),
    mapsUrl: emptyToBlank(location.maps_url),
  };
}

// "Just Lepak Only" on the event page (migrations/017): whether the event
// takes lepak RSVPs, what the choice says, the cap and the places left
// (both null with no cap). row.lepak_taken holds how many are lepak
// (events.js withMealCounts).
function lepakView(row) {
  if (!lepakOffered(row)) {
    return { offered: false, label: null, limit: null, left: null };
  }
  const limit = lepakLimit(row);
  let left = null;
  if (limit !== null) {
    left = Math.max(0, limit - numberOrZero(row.lepak_taken));
  }
  return { offered: true, label: lepakLabel(row), limit, left };
}

// The meals an event offers for meal-only RSVPs, in order, for the event
// page: { id, label, limit, left, locations }, label null for breakfast,
// lunch and dinner (the page names those in the reader's language); limit
// and the places left null for a meal with no limit; locations the meal's
// own places when it is held somewhere other than the event (empty: at the
// event's), with addresses as addressShown allows, like the event's own.
// row.meal_taken holds how many are coming for each (events.js
// withMealCounts).
function mealsView(row, addressShown) {
  let taken = row.meal_taken;
  if (taken === null || taken === undefined) {
    taken = {};
  }
  return storedMeals(row).map((meal) => {
    let left = null;
    if (meal.limit !== null) {
      left = Math.max(0, meal.limit - numberOrZero(taken[meal.id]));
    }
    return {
      id: meal.id,
      label: meal.label,
      limit: meal.limit,
      left,
      locations: meal.locations.map((location) => locationView(location, addressShown)),
    };
  });
}

// Of the meals someone chose (ids), the ones the event still offers, in its
// order. A meal the editor has stopped offering is left out, and someone
// left with none is coming to the whole event (migrations/007).
export function offeredMeals(row, chosen) {
  if (!Array.isArray(chosen) || chosen.length === 0) {
    return [];
  }
  return storedMeals(row)
    .map((meal) => meal.id)
    .filter((id) => chosen.includes(id));
}

// What a tier includes of other tiers (migrations/022), as the editor chose
// to show it: those tiers' benefits in full (includedBenefits, furthest
// first), or the name of the tier it includes (includesTier). tiers:
// storedTiers(row).
function includedView(tiers, tier) {
  const chain = includedTiers(tiers, tier);
  if (chain.length > 0 && tier.previous_display === 'full') {
    return { includedBenefits: [...chain].reverse().flatMap((each) => each.benefits), includesTier: null };
  }
  if (chain.length > 0) {
    return { includedBenefits: [], includesTier: chain[0].name };
  }
  return { includedBenefits: [], includesTier: null };
}

// The ticket tiers on the event page, in order, while they are on (a paid
// event only; none otherwise). Each is its name, its price (null while the
// price is hidden: the page then shows the tiers without prices), its own
// benefits, and, when it includes another tier (any of them,
// migrations/022), either those benefits in full (includedBenefits,
// everything that tier gives, and what it includes in turn, furthest first)
// or that tier's name (includesTier), as the editor chose; how many of
// it one person can buy (maxPerPerson, 1 for once); and how many people it
// takes and the places left (limit and left, both null with no limit,
// migrations/025; row.tier_taken from events.js withTierCounts), and
// whether it is sold out (full).
function tiersView(row) {
  if (row.tiers_enabled !== true || row.price_type !== 'paid') {
    return [];
  }
  const tiers = storedTiers(row);
  const priceShown = row.price_hidden !== true;
  return tiers.map((tier) => {
    const { includedBenefits, includesTier } = includedView(tiers, tier);
    let price = null;
    if (priceShown) {
      price = tier.price;
    }
    // How this tier can be paid for (migrations/016), when it says.
    const methods = tierOptions(row, tier);
    // When it stops being sold, and whether it has (migrations/024).
    const left = tierLeft(row, tier);
    return { name: tier.name, price, currency: tierCurrency(row, tier), benefits: tier.benefits, includedBenefits, includesTier, maxPerPerson: tier.max_per_person, methods, closesAt: missingToNull(tier.closes_at), closed: tierClosed(tier), limit: tier.limit, left, full: left === 0 };
  });
}

// The link label as stored (migrations/015), read as "Tickets and website"
// when it is not one of LINK_LABELS.
function storedLinkLabel(row) {
  if (LINK_LABELS.includes(row.external_url_label)) {
    return row.external_url_label;
  }
  return 'tickets_website';
}

// What the link button says on the event page: the stored label, except
// that 'custom' with no words of its own says "Tickets and website".
function linkLabelOf(row) {
  const label = storedLinkLabel(row);
  if (label === 'custom' && !row.external_url_custom_label) {
    return 'tickets_website';
  }
  return label;
}

// The event's link on its page, or null when it has none: its address, what
// its button says (label, and customLabel for the editor's own words), and
// locked when this viewer may not have it yet. A cross-border event's link
// goes only to people signed in with a country of origin, and to editors:
// locked is 'sign-in' for someone signed out and 'country' for someone with
// no country set, and the address is then left out.
function externalLinkView(row, viewer) {
  if (!row.external_url) {
    return null;
  }
  let locked = null;
  if (row.cross_border === true && viewer.canManage !== true) {
    if (viewer.signedIn !== true) {
      locked = 'sign-in';
    } else if (!viewer.country) {
      locked = 'country';
    }
  }
  let url = null;
  if (locked === null) {
    url = row.external_url;
  }
  const label = linkLabelOf(row);
  let customLabel = null;
  if (label === 'custom') {
    customLabel = row.external_url_custom_label;
  }
  return { url, label, customLabel, locked };
}

// The timetable on the event page (migrations/014), or null when there is
// none to show: no items, or the dates are to be announced (its days would
// give them away). view is how the editor wants it shown ("timeline" or
// "grid"); rooms are the grid's columns, in order ({ name, tag }); items
// are in time order, each with its day, start and end as the editor typed
// them (wall-clock in the event's zone, end null when there is none), the
// moments it starts and ends (for what is on now), whether the end is the
// next day, its room's place in rooms (null for none) and its note.
//
// A timeline's steps have a time only, so it goes out with no rooms and no
// ends, even if some were kept from when it was a grid.
function timetableDetail(row) {
  if (!datesAnnounced(row)) {
    return null;
  }
  const timetable = storedTimetable(row);
  if (timetable.items.length === 0) {
    return null;
  }
  const timeline = timetable.view === 'timeline';
  let rooms = timetable.rooms;
  if (timeline) {
    rooms = [];
  }
  const roomPlace = new Map(rooms.map((room, index) => [room.id, index]));
  return {
    view: timetable.view,
    rooms: rooms.map((room) => ({ name: room.name, tag: room.tag })),
    items: timetable.items.map((item) => {
      let shown = item;
      if (timeline) {
        shown = { ...item, end: null, room: null };
      }
      const times = itemTimes(shown, row.timezone);
      let room = null;
      if (shown.room !== null) {
        room = roomPlace.get(shown.room);
      }
      return {
        title: item.title,
        date: item.date,
        start: item.start,
        end: shown.end,
        endsNextDay: times.endsNextDay,
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        room,
        note: item.note,
      };
    }),
  };
}

// The timetable on the edit form, every field a string: how the page shows
// it, the rooms with their ids, and the items with their room's id ('' for
// none).
function managedTimetable(row) {
  const timetable = storedTimetable(row);
  return {
    timetableView: timetable.view,
    timetableRooms: timetable.rooms.map((room) => ({ id: room.id, name: room.name, tag: emptyToBlank(room.tag) })),
    timetableItems: timetable.items.map((item) => ({
      title: item.title,
      date: item.date,
      start: item.start,
      end: emptyToBlank(item.end),
      room: emptyToBlank(item.room),
      note: emptyToBlank(item.note),
    })),
  };
}

// One tier on the edit form, its price and benefits as the fields hold
// them (the benefits one per line).
function managedTier(tier, row) {
  return {
    id: tier.id,
    name: tier.name,
    price: String(tier.price),
    benefits: tier.benefits.join('\n'),
    includes: emptyToBlank(tier.includes),
    previousDisplay: tier.previous_display,
    maxPerPerson: tier.max_per_person,
    limit: emptyToBlank(tier.limit),
    currency: emptyToBlank(tier.currency),
    paymentMethods: tier.payment_methods,
    paymentLink: emptyToBlank(tier.payment_link),
    paymentQrUrl: emptyToBlank(qrUrl({ slug: row.slug, payment_qr_path: tier.payment_qr_path })),
    closesLocal: emptyToBlank(utcToWall(tier.closes_at, row.timezone)),
  };
}

// Volunteers on the event page (migrations/012): whether the convention
// takes volunteer sign-ups, and its benefit for the people who volunteered
// at an earlier convention while that is in effect (null otherwise): a
// percentage or an amount in the event's currency (SGD when it has none, as
// for a paid event), and the earlier convention's title and link, both null
// while that event is not public.
function volunteersView(row) {
  let discount = null;
  if (volunteerDiscountActive(row)) {
    const source = row.volunteer_source;
    let fromTitle = null;
    let fromSlug = null;
    if (source && isReleased(source)) {
      fromTitle = source.title;
      fromSlug = source.slug;
    }
    let currency = null;
    if (row.volunteer_discount_type === 'amount') {
      currency = emptyToNull(row.currency);
      if (!currency) {
        currency = 'SGD';
      }
    }
    discount = {
      type: row.volunteer_discount_type,
      value: Number(row.volunteer_discount_value),
      currency,
      fromTitle,
      fromSlug,
    };
  }
  return { wanted: takesVolunteers(row), discount };
}

// The count of people going to the whole event (who take its spaces), from
// an embedded aggregate (gftvevents_full_attendees(count), migrations/009;
// gftvevents_attendees(count) before it) or a number.
export function goingCount(row) {
  let embedded = row.gftvevents_full_attendees;
  if (embedded === undefined) {
    embedded = row.gftvevents_attendees;
  }
  if (Array.isArray(embedded)) {
    const aggregate = embedded[0];
    let count;
    if (aggregate !== null && aggregate !== undefined) {
      count = aggregate.count;
    }
    return numberOrZero(count);
  }
  return numberOrZero(row.going_count);
}

// The capacity and the spaces left, both null when there is no limit.
function spacesView(row, going) {
  if (!row.capacity) {
    return { capacity: null, left: null };
  }
  return { capacity: row.capacity, left: Math.max(0, row.capacity - going) };
}

function rsvpState(row, going, now) {
  if (row.status === 'cancelled') {
    return 'cancelled';
  }
  if (isOver(row, now)) {
    return 'over';
  }
  if (!row.rsvp_open) {
    return 'closed';
  }
  if (row.capacity && going >= row.capacity) {
    return 'full';
  }
  return 'open';
}

// A card in the public feed (and in "Events you are going to" on the account
// page). Only call this for a released event. A card shows no spaces left
// and no price note; the event page adds those.
export function publicEventCard(row, now = Date.now()) {
  const going = goingCount(row);
  return {
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    summary: emptyToNull(row.summary),
    coverImageUrl: coverUrl(row),
    cancelled: row.status === 'cancelled',
    when: whenView(row),
    where: {
      online: row.is_online === true,
      venueName: emptyToNull(row.venue_name),
      city: emptyToNull(row.city),
      country: emptyToNull(row.country),
    },
    price: priceView(row),
    going,
    rsvp: rsvpState(row, going, now),
  };
}

// The event page. viewer: { signedIn, going, meals, canManage, volunteer,
// volunteered, discount, rsvpNumber } (rsvpNumber: their RSVP ID for this
// event, migrations/013; meals: the ones this person is coming for, empty
// for the whole event; volunteer: they signed up to volunteer here;
// volunteered: an editor confirmed they did; discount: they volunteered at
// the earlier convention this one's benefit is for). Only call this for a
// released event, or for an editor. Call events.js withVolunteerSource on
// the row first, for the benefit's convention.
//
// It is the card plus the price note, the spaces left, the descriptions (in
// English and Chinese), the organiser, the link, every location, the ticket
// tiers, the meals people can come to on their own and the timetable. People going
// and editors ("insiders") also get attendees-only addresses and map links,
// and the online link; everyone else gets only a flag saying there is one
// for attendees.
export function publicEventDetail(row, viewer = {}, now = Date.now()) {
  const card = publicEventCard(row, now);
  let insider = false;
  if (viewer.going === true || viewer.canManage === true) {
    insider = true;
  }
  let addressShown = false;
  if (!row.address_attendees_only || insider) {
    addressShown = true;
  }

  const locations = storedLocations(row);
  const mealLocations = storedMeals(row).flatMap((meal) => meal.locations);
  const hasAddress = [...locations, ...mealLocations].some((location) => {
    if (location.venue_address || location.maps_url) {
      return true;
    }
    return false;
  });
  let addressForAttendees = false;
  if (row.address_attendees_only && hasAddress && !addressShown) {
    addressForAttendees = true;
  }
  let onlineUrl = null;
  if (insider && row.is_online) {
    onlineUrl = emptyToNull(row.online_url);
  }
  let onlineUrlForAttendees = false;
  if (row.is_online && row.online_url && !insider) {
    onlineUrlForAttendees = true;
  }
  let myMeals = [];
  if (viewer.going === true) {
    myMeals = offeredMeals(row, viewer.meals);
  }

  // Volunteering is shown only to someone going (signed up) and to whoever
  // volunteered; the benefit only while it is in effect.
  let volunteer = false;
  if (viewer.going === true && viewer.volunteer === true) {
    volunteer = true;
  }
  let rsvpNumber = null;
  if (viewer.going === true && Number.isInteger(viewer.rsvpNumber)) {
    rsvpNumber = viewer.rsvpNumber;
  }
  let volunteerDiscount = false;
  if (viewer.discount === true && volunteerDiscountActive(row)) {
    volunteerDiscount = true;
  }
  // A cross-border event needs a country of origin to RSVP (migrations/015).
  let needsCountry = false;
  if (row.cross_border === true && viewer.signedIn === true && !viewer.country) {
    needsCountry = true;
  }
  // Someone going who said they are a fursuiter (migrations/023).
  let myFursuiter = false;
  if (viewer.going === true && viewer.fursuiter === true) {
    myFursuiter = true;
  }
  // Someone going lepak, without a ticket (migrations/017).
  let myLepak = false;
  if (viewer.going === true && viewer.lepak === true) {
    myLepak = true;
  }
  // Someone going: how they are paying and where it stands (migrations/016).
  // Anyone else: nothing to pay.
  let myPayment = { method: null, status: 'none' };
  if (viewer.going === true && viewer.payment) {
    myPayment = { method: missingToNull(viewer.payment.payment_method), status: paymentStatusOf(viewer.payment) };
  }
  const { myContact, contactMissing } = viewerContact(row, viewer);

  return {
    ...card,
    price: priceView(row, { withNote: true }),
    ...spacesView(row, card.going),
    // Rich text (rich-text.js), its pictures as this site's addresses.
    description: emptyToNull(displayDescription(row, row.description)),
    descriptionZh: emptyToNull(displayDescription(row, row.description_zh)),
    organiserName: emptyToNull(row.organiser_name),
    externalLink: externalLinkView(row, viewer),
    crossBorder: row.cross_border === true,
    where: {
      ...card.where,
      locations: locations.map((location) => locationView(location, addressShown)),
      addressForAttendees,
      onlineUrl,
      onlineUrlForAttendees,
    },
    gallery: galleryView(row),
    tiers: tiersView(row),
    meals: mealsView(row, addressShown),
    lepak: lepakView(row),
    contact: contactView(row),
    registration: registrationView(row),
    timetable: timetableDetail(row),
    volunteers: volunteersView(row),
    // Whether people going are asked if they are fursuiters (migrations/023),
    // by the plain tick box (not when the registration form asks it).
    fursuitersAsked: fursuiterTickShown(row),
    // How people pay, and whether a ticket goes through /checkout.
    payment: { checkout: needsCheckout(row), methods: paymentOptions(row) },
    viewer: {
      signedIn: viewer.signedIn === true,
      going: viewer.going === true,
      lepak: myLepak,
      payment: myPayment,
      rsvpNumber,
      meals: myMeals,
      canManage: viewer.canManage === true,
      volunteer,
      fursuiter: myFursuiter,
      volunteered: viewer.volunteered === true,
      volunteerDiscount,
      needsCountry,
      contact: myContact,
      contactMissing,
      registration: viewerRegistration(row, viewer, now),
      // Whether they can upgrade their tier at checkout (migrations/024).
      canUpgrade: canUpgradeNow(row, viewer, volunteerDiscount, now),
    },
  };
}

// Whether someone going has a tier to upgrade to.
function canUpgradeNow(row, viewer, volunteerDiscount, now) {
  if (viewer.going !== true || !viewer.payment) {
    return false;
  }
  const upgrade = upgradeOptions(row, viewer.payment, { volunteerDiscount, now });
  if (upgrade === null) {
    return false;
  }
  return upgrade.options.length > 0;
}

// One of my RSVPs, for the account page: the event's card and my RSVP ID
// for it (migrations/013). The page shows no RSVP date, so none is sent.
export function myRsvpView(row, now = Date.now()) {
  const event = row.event;
  let card = null;
  if (event) {
    card = publicEventCard(event, now);
  }
  return { event: card, rsvpNumber: missingToNull(row.rsvp_number), paymentStatus: paymentStatusOf(row) };
}

// An editor's list row: what the list on /manage shows (title, status, kind,
// date or "to be announced", people going) and the id and slug its Edit
// button and ?slug= link use.
export function managedSummary(row, now = Date.now()) {
  // Released: not a draft, and either no release time or one already past.
  let released = false;
  if (row.status !== 'draft' && (!row.publish_at || new Date(row.publish_at).getTime() <= now)) {
    released = true;
  }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    released,
    startsAt: emptyToNull(row.starts_at),
    datesHidden: row.dates_hidden === true,
    going: goingCount(row),
    capacity: missingToNull(row.capacity),
  };
}

// The event page's gallery (migrations/019): each picture's address and its
// size, so the page lays it out in its own shape before it loads. row.gallery
// is added by gallery.js withGallery; none when it was not.
function galleryView(row) {
  if (!Array.isArray(row.gallery)) {
    return [];
  }
  const pictures = [];
  for (const image of row.gallery) {
    const url = galleryImageUrl(row.slug, image.path);
    if (url) {
      pictures.push({ url, width: image.width, height: image.height });
    }
  }
  return pictures;
}

// One gallery picture in the edit form: its id for the buttons, its address
// and its size.
export function managedGalleryImage(image, slug) {
  return {
    id: image.id,
    url: emptyToBlank(galleryImageUrl(slug, image.path)),
    width: image.width,
    height: image.height,
  };
}

// The crop a cover was cut with ({ x, y, width, height } in the gallery
// picture's pixels), or null.
function storedCrop(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const crop = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(value[key])) {
      return null;
    }
    crop[key] = value[key];
  }
  return crop;
}

// The cover picture alone, for the answer to an upload or removal
// (api/manage/cover.js): the edit form redraws only its cover preview.
// coverSourceId is the gallery picture it was cut from ('' when none is
// known, or that picture has gone) and coverCrop the crop, so "Adjust crop"
// can start from it.
export function managedCover(row) {
  let sourceId = emptyToBlank(row.cover_source_image_id);
  if (!row.cover_image_path) {
    sourceId = '';
  }
  let crop = null;
  if (sourceId) {
    crop = storedCrop(row.cover_crop);
  }
  return {
    coverImageUrl: emptyToBlank(coverUrl(row)),
    hasCover: Boolean(row.cover_image_path),
    coverSourceId: sourceId,
    coverCrop: crop,
  };
}

// Everything an editor can change, in the shape the edit form sends back,
// plus the id and slug the form's buttons use. Nothing the form does not
// fill in: no counts, no "released" flag, no stored timestamps. An empty
// text column comes back as '', so the form shows a blank field.
export function managedEvent(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    datesHidden: row.dates_hidden === true,
    timezone: row.timezone,
    capacity: missingToNull(row.capacity),
    summary: emptyToBlank(row.summary),
    description: emptyToBlank(displayDescription(row, row.description)),
    descriptionZh: emptyToBlank(displayDescription(row, row.description_zh)),
    ...managedWhen(row),
    publishLocal: utcToWall(row.publish_at, row.timezone),
    isOnline: row.is_online === true,
    onlineUrl: emptyToBlank(row.online_url),
    locations: storedLocations(row).map(managedLocation),
    addressAttendeesOnly: row.address_attendees_only === true,
    ...managedCover(row),
    externalUrl: emptyToBlank(row.external_url),
    externalUrlLabel: storedLinkLabel(row),
    externalUrlCustomLabel: emptyToBlank(row.external_url_custom_label),
    crossBorder: row.cross_border === true,
    organiserName: emptyToBlank(row.organiser_name),
    priceType: row.price_type,
    priceHidden: row.price_hidden === true,
    priceMin: stringOrBlank(row.price_min),
    priceMax: stringOrBlank(row.price_max),
    currency: emptyToBlank(row.currency),
    priceNote: emptyToBlank(row.price_note),
    tiersEnabled: row.tiers_enabled === true,
    ticketTiers: storedTiers(row).map((tier) => managedTier(tier, row)),
    rsvpOpen: row.rsvp_open !== false,
    meals: storedMeals(row).map((meal) => ({
      id: meal.id,
      label: emptyToBlank(meal.label),
      limit: stringOrBlank(meal.limit),
      locations: meal.locations.map(managedLocation),
    })),
    volunteersWanted: row.volunteers_wanted === true,
    fursuitersAsked: row.fursuiters_asked === true,
    volunteerDiscountEnabled: row.volunteer_discount_enabled === true,
    volunteerDiscountFrom: emptyToBlank(row.volunteer_discount_from),
    volunteerDiscountType: volunteerDiscountType(row),
    volunteerDiscountValue: stringOrBlank(row.volunteer_discount_value),
    ...managedTimetable(row),
    lepakEnabled: row.lepak_enabled === true,
    lepakLimit: stringOrBlank(row.lepak_limit),
    lepakLabel: emptyToBlank(row.lepak_label),
    contactFields: storedContactFields(row),
    contactRule: storedContactRule(row),
    registrationEnabled: row.registration_enabled === true,
    registrationFields: configuredRegistrationFields(row),
    paymentMethods: storedPaymentMethods(row),
    paymentLink: emptyToBlank(row.payment_link),
    paymentInstructions: emptyToBlank(row.payment_instructions),
    ...managedPaymentQr(row),
    staffNotes: emptyToBlank(row.staff_notes),
  };
}

// The payment QR code (migrations/016), also the whole answer to an upload
// or removal (api/manage/payment-qr.js), and why any ticked online method
// cannot be offered yet (event-rules.js paymentProblems), which a new QR
// code can change.
export function managedPaymentQr(row) {
  return {
    paymentQrUrl: emptyToBlank(qrUrl(row)),
    paymentProblems: paymentProblems(row),
  };
}

// The answer to a tier's QR code upload or removal: the event's QR code and
// problems, and each tier's QR code by its id.
export function managedTierQr(row) {
  return {
    ...managedPaymentQr(row),
    tierQrUrls: storedTiers(row).map((tier) => ({ id: tier.id, paymentQrUrl: emptyToBlank(qrUrl({ slug: row.slug, payment_qr_path: tier.payment_qr_path })) })),
  };
}

// The tickets a checkout offers: each tier (or the one price, when the
// event has no tiers), with its price and what it costs this person after
// any volunteer benefit. index is what the page sends back to pick a tier
// (null without tiers). Several tiers can be bought at once
// (migrations/022), each up to maxPerPerson; they can be paid for together
// in the ways they all take, by link or QR code only when they share one:
// payTo says which link and which QR code each pays to ("event" for the
// event's own, else the tier's id), without giving either away before a
// place is reserved.
function checkoutTickets(row, volunteerDiscount) {
  const tiers = storedTiers(row);
  if (sellsTiers(row)) {
    return tiers.map((tier, index) => {
      const priced = ticketPrice(row, { tierIndex: index, tierName: tier.name, volunteerDiscount, ignoreClosed: true });
      let linkTo = 'event';
      if (tier.payment_link) {
        linkTo = tier.id;
      }
      let qrTo = 'event';
      if (tier.payment_qr_path) {
        qrTo = tier.id;
      }
      const left = tierLeft(row, tier);
      // What it includes of another tier, as the event page shows it.
      const { includedBenefits, includesTier } = includedView(tiers, tier);
      return {
        index,
        name: tier.name,
        benefits: tier.benefits,
        includedBenefits,
        includesTier,
        price: priced.price,
        amount: priced.amount,
        currency: priced.currency,
        maxPerPerson: tier.max_per_person,
        methods: tierOptions(row, tier),
        payTo: { link: linkTo, qr: qrTo },
        closed: tierClosed(tier),
        left,
        full: left === 0,
      };
    });
  }
  const priced = ticketPrice(row, { volunteerDiscount });
  if (!priced.ok) {
    return [];
  }
  return [{ index: null, name: null, benefits: [], includedBenefits: [], includesTier: null, price: priced.price, amount: priced.amount, currency: priced.currency, maxPerPerson: 1, methods: paymentOptions(row), payTo: { link: 'event', qr: 'event' }, closed: false, left: null, full: false }];
}

// The tiers someone bought, as kept at checkout (migrations/022): each
// { name, quantity, price }, or empty for a ticket from before (its one
// tier is then only in tier).
function paymentItemsView(stored) {
  if (!Array.isArray(stored.payment_items)) {
    return [];
  }
  return stored.payment_items
    .filter((item) => {
      if (item === null || typeof item !== 'object') {
        return false;
      }
      return typeof item.name === 'string';
    })
    .map((item) => {
      let quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        quantity = 1;
      }
      return { name: item.name, quantity, price: numberOrNull(item.price) };
    });
}

// The volunteer benefit this person gets at checkout, { type ('percent' or
// 'amount'), value }, or null for none.
function checkoutBenefit(row, volunteerDiscount) {
  if (!volunteerDiscount) {
    return null;
  }
  return { type: volunteerDiscountType(row), value: Number(row.volunteer_discount_value) };
}

// The ways someone holding a ticket can pay for it now, or [] for none.
function heldMethods(row, viewer) {
  if (viewer.going !== true || !viewer.payment) {
    return [];
  }
  return ticketOptions(row, viewer.payment);
}

// Someone's own payment at checkout, from their attendee row.
function myCheckoutPayment(stored) {
  return {
    method: missingToNull(stored.payment_method),
    status: paymentStatusOf(stored),
    tier: missingToNull(stored.payment_tier),
    items: paymentItemsView(stored),
    amount: numberOrNull(stored.payment_amount),
    currency: missingToNull(stored.payment_currency),
    reference: missingToNull(stored.payment_reference),
    hasProof: Boolean(stored.payment_proof_path),
    // After an upgrade (migrations/024): what was already paid, and what is
    // left to pay (the whole amount when nothing was).
    credit: paidCredit(stored),
    due: amountDue(stored),
  };
}

function paidCredit(stored) {
  if (stored.payment_status === 'paid') {
    return 0;
  }
  return paidSoFar(stored);
}

function amountDue(stored) {
  const amount = numberOrNull(stored.payment_amount);
  if (amount === null) {
    return null;
  }
  return Math.max(0, Math.round((amount - paidSoFar(stored)) * 100) / 100);
}

// The checkout page (migrations/016), for someone signed in. Only call this
// for a released event, or for an editor. viewer: as for publicEventDetail,
// with payment the person's attendee row (its payment columns) or null.
//
// The event's title, cover and dates, the tickets with their prices (shown
// here even when the event page hides them: this person is about to pay),
// the ways to pay, the organiser's instructions, and the person's own place
// and payment. The payment link and QR code go only to someone who has
// reserved a place paying that way.
export function checkoutView(row, viewer = {}, now = Date.now()) {
  const card = publicEventCard(row, now);
  let volunteerDiscount = false;
  if (viewer.discount === true && volunteerDiscountActive(row)) {
    volunteerDiscount = true;
  }
  let mine = null;
  let paymentLink = null;
  let paymentQrUrl = null;
  if (viewer.going === true && viewer.payment) {
    mine = myCheckoutPayment(viewer.payment);
    // The link and QR code of the tiers their ticket is for (one for them
    // all, event-rules.js basketOptions), or the event's.
    const held = heldTiers(row, viewer.payment);
    let tier = null;
    if (held.length > 0) {
      tier = held[0];
    }
    if (mine.method === 'link' && mine.status !== 'none') {
      paymentLink = tierLink(row, tier);
    }
    if (mine.method === 'qr' && mine.status !== 'none') {
      paymentQrUrl = qrUrl({ slug: row.slug, payment_qr_path: tierQrPath(row, tier) });
    }
  }
  let needsCountry = false;
  if (row.cross_border === true && !viewer.country) {
    needsCountry = true;
  }
  let rsvpNumber = null;
  let volunteer = false;
  let fursuiter = false;
  // Going without a ticket: just for meals, or lepak (migrations/017).
  let withoutTicket = false;
  if (viewer.going === true) {
    if (Number.isInteger(viewer.rsvpNumber)) {
      rsvpNumber = viewer.rsvpNumber;
    }
    volunteer = viewer.volunteer === true;
    fursuiter = viewer.fursuiter === true;
    if ((Array.isArray(viewer.meals) && viewer.meals.length > 0) || viewer.lepak === true) {
      withoutTicket = true;
    }
  }
  const { myContact, contactMissing } = viewerContact(row, viewer);

  return {
    slug: card.slug,
    title: card.title,
    coverImageUrl: card.coverImageUrl,
    when: card.when,
    rsvp: card.rsvp,
    currency: emptyToNull(row.currency),
    tickets: checkoutTickets(row, volunteerDiscount),
    volunteerDiscount,
    // The benefit itself, so the page can work out a basket's total as the
    // server will (event-rules.js basketPrice): taken off the total once.
    volunteerBenefit: checkoutBenefit(row, volunteerDiscount),
    methods: paymentOptions(row),
    // The ways to pay the ticket held, for "Pay another way".
    heldMethods: heldMethods(row, viewer),
    checkout: needsCheckout(row),
    instructions: emptyToNull(row.payment_instructions),
    paymentLink,
    paymentQrUrl,
    takesVolunteers: takesVolunteers(row),
    asksFursuiters: fursuiterTickShown(row),
    needsCountry,
    contact: contactView(row),
    registration: registrationView(row),
    viewer: {
      going: viewer.going === true,
      withoutTicket,
      rsvpNumber,
      volunteer,
      fursuiter,
      payment: mine,
      contact: myContact,
      contactMissing,
      registration: viewerRegistration(row, viewer, now),
      // The donation in their order (migrations/024), 0 for none.
      donation: myDonation(row, viewer),
      // The tiers they can upgrade to, and what each costs (null: none).
      upgrade: myUpgrade(row, viewer, volunteerDiscount, now),
    },
  };
}

function myDonation(row, viewer) {
  if (viewer.going !== true) {
    return 0;
  }
  return donationOf(row, viewer.registration);
}

function myUpgrade(row, viewer, volunteerDiscount, now) {
  if (viewer.going !== true || !viewer.payment) {
    return null;
  }
  const upgrade = upgradeOptions(row, viewer.payment, { volunteerDiscount, now });
  if (!upgrade || upgrade.options.length === 0) {
    return null;
  }
  return upgrade;
}

// The kind of volunteer benefit, 'percent' unless it is stored as 'amount'.
function volunteerDiscountType(row) {
  if (row.volunteer_discount_type === 'amount') {
    return 'amount';
  }
  return 'percent';
}
