// Registration form photos, such as a con badge photo (migrations/024).
//
// POST /api/events/registration-photo { slug, question, picture }
//   A WebP the browser made (js/picture-file.js), for one of the event's
//   photo questions. payments.js checks and re-encodes it, and keeps it in
//   the private gftvevents_payments bucket under the event and the account.
//   Someone going (while registration is open for them) has it saved as
//   their answer at once, and the photo it replaces deleted. Anyone else
//   gets back its name, to send as the answer with their RSVP
//   (api/events/rsvp.js checks the file is theirs and there).
//   -> { photo: name, url, event? } (event: the page's event again, when
//   the answer was saved).
//
// GET /api/events/registration-photo?slug=&q=<question>&v=<name>[&u=<username>&staff=1]
//   The photo itself: the person's own, or, with u, an attendee's, for the
//   event's editors only. Never cached by a shared cache: it is personal.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { releasedEventBySlug, anyEventBySlug, attendance, withMealCounts, withVolunteerSource, volunteerStanding, DETAIL_COLUMNS } from '../_lib/events.js';
import { registrationOpenFor, heldRegistrationFields } from '../_lib/event-rules.js';
import { preparePicture, storeRegistrationPhoto, registrationPhotoPath, readPaymentFile, deletePaymentFiles, MAX_PROOF_BYTES } from '../_lib/payments.js';
import { publicEventDetail } from '../_lib/serialize.js';
import { withGallery } from '../_lib/gallery.js';
import { withDescriptionPictures } from '../_lib/description-pictures.js';
import { storedRegistrationFields, readRegistrationAnswers, PHOTO_NAME } from '../../js/registration-fields.js';

const MAX_BODY_BYTES = Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 4096;

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

// The event for this person: a released one, or any for its editors.
async function eventFor(slug, user) {
  const released = await releasedEventBySlug(slug);
  if (released) {
    return released;
  }
  const any = await anyEventBySlug(slug, DETAIL_COLUMNS);
  if (any && (await canEditEvent(user, any.id))) {
    return any;
  }
  return null;
}

// The photo question an event asks with this id, or null.
function photoQuestion(event, id) {
  const field = storedRegistrationFields(event).find((each) => each.id === id);
  if (!field || field.type !== 'photo') {
    return null;
  }
  return field;
}

// The username on an attendee row's account, staff or public.
function usernameOf(account) {
  if (!account) {
    return null;
  }
  if (account.kind === 'staff') {
    if (account.staff) {
      return account.staff.username;
    }
    return null;
  }
  return account.username;
}

// The account id of the attendee an editor named, or null.
async function attendeeId(eventId, username, staff) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`user_id, account:${TABLES.accounts}!user_id ( kind, username, staff:${TABLES.users} ( username ) )`)
    .eq('event_id', eventId);
  if (error) {
    throw error;
  }
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  }
  const match = rows.find((row) => {
    if (!row.account || usernameOf(row.account) !== username) {
      return false;
    }
    return (row.account.kind === 'staff') === staff;
  });
  if (!match) {
    return null;
  }
  return match.user_id;
}

async function showPhoto(request, response, user) {
  const event = await eventFor(query(request, 'slug').toLowerCase(), user);
  const questionId = query(request, 'q');
  const name = query(request, 'v');
  if (!event || !photoQuestion(event, questionId) || !PHOTO_NAME.test(name)) {
    return notFound(response);
  }
  let ownerId = user.id;
  const username = query(request, 'u').trim();
  if (username) {
    if (!(await canEditEvent(user, event.id))) {
      return notFound(response);
    }
    ownerId = await attendeeId(event.id, username, query(request, 'staff') === '1');
    if (!ownerId) {
      return notFound(response);
    }
  }
  const file = await readPaymentFile(registrationPhotoPath(event.id, ownerId, name));
  if (!file) {
    return notFound(response);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', file.type);
  response.setHeader('Content-Length', String(file.bytes.length));
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(file.bytes);
}

// The page's event again, as this person now sees it.
async function eventAnswer(event, user) {
  await withMealCounts(event);
  await withVolunteerSource(event);
  await withGallery(event);
  await withDescriptionPictures(event);
  const mine = await attendance(event.id, user.id);
  const standing = await volunteerStanding(event, user.id);
  return publicEventDetail(event, {
    signedIn: true,
    going: mine.going,
    meals: mine.meals,
    lepak: mine.lepak,
    rsvpNumber: mine.rsvpNumber,
    canManage: await canEditEvent(user, event.id),
    volunteer: mine.volunteer,
    fursuiter: mine.fursuiter,
    volunteered: standing.volunteered,
    discount: standing.discount,
    country: user.country,
    payment: mine.payment,
    contact: mine.contact,
    registration: mine.registration,
    personal: user.personal,
  });
}

async function uploadPhoto(request, response, user) {
  const body = await readJson(request, response, { maxBytes: MAX_BODY_BYTES });
  if (!body) {
    return;
  }
  if (await limited(request, response, 'payment', [`u:${user.id}`])) {
    return;
  }
  let typedSlug = '';
  if (typeof body.slug === 'string') {
    typedSlug = body.slug;
  }
  const event = await eventFor(typedSlug.toLowerCase(), user);
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  const question = photoQuestion(event, body.question);
  if (!question) {
    return fail(response, 400, 'bad_request');
  }
  const mine = await attendance(event.id, user.id);
  if (mine.going && !registrationOpenFor(event, mine.payment)) {
    return fail(response, 409, 'registration_closed');
  }
  // Someone going answers only the questions the tiers they hold are asked.
  const fields = heldRegistrationFields(event, mine.payment);
  if (mine.going && !fields.some((field) => field.id === question.id)) {
    return fail(response, 400, 'bad_request');
  }
  const prepared = await preparePicture(body.picture, 'photo');
  if (!prepared.ok) {
    return fail(response, 400, prepared.error);
  }
  const name = await storeRegistrationPhoto(event.id, user.id, prepared.buffer);
  const url = `/api/events/registration-photo?slug=${encodeURIComponent(event.slug)}&q=${encodeURIComponent(question.id)}&v=${encodeURIComponent(name)}`;
  if (!mine.going) {
    return ok(response, { photo: name, url });
  }
  // Someone going: saved as their answer now (the rest of their answers as
  // they were; a form that has since asked more is not held against them
  // here, only the photo changes).
  const read = readRegistrationAnswers(fields, { [question.id]: name }, mine.registration);
  let answers = { ...mine.registration, [question.id]: name };
  if (read.ok) {
    answers = read.answers;
  }
  const columns = { registration: answers };
  const { error } = await database()
    .from(TABLES.attendees)
    .update(columns)
    .eq('event_id', event.id)
    .eq('user_id', user.id);
  if (error) {
    await deletePaymentFiles([registrationPhotoPath(event.id, user.id, name)]);
    throw error;
  }
  const before = mine.registration[question.id];
  if (typeof before === 'string' && before !== name && PHOTO_NAME.test(before)) {
    await deletePaymentFiles([registrationPhotoPath(event.id, user.id, before)]);
  }
  await audit(request, { action: 'rsvp.registration_photo', actorId: user.id, eventId: event.id, details: { question: question.id } });
  return ok(response, { photo: name, url, event: await eventAnswer(event, user) });
}

export default route('events/registration-photo', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  if (request.method === 'GET') {
    await showPhoto(request, response, session.user);
    return;
  }
  await uploadPhoto(request, response, session.user);
});
