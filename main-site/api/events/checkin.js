// POST /api/events/checkin { slug, code }  -> { checkedInAt, already }
//
// Self check-in (migrations/027): someone going scans the QR code the
// organisers show while self check-in is on (the "beacon",
// api/_lib/checkin.js). It opens the event page with ?checkin=<code>, and
// the page sends the code here. The code has to be this event's and recent
// (it changes every 30 seconds and is taken for 5 minutes), self check-in
// has to still be on, and the person has to be going. Checking in again
// answers already: true. Refused with self_checkin_off, checkin_code_invalid
// (an old or another event's code) or not_going.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { releasedEventBySlug, attendance } from '../_lib/events.js';
import { beaconCodeValid } from '../_lib/checkin.js';

export default route('events/checkin', async (request, response) => {
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
  if (await limited(request, response, 'selfCheckin', [`u:${session.user.id}`])) {
    return;
  }
  let typedSlug = '';
  if (typeof body.slug === 'string') {
    typedSlug = body.slug;
  }
  const event = await releasedEventBySlug(typedSlug.toLowerCase());
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  if (event.self_checkin_on !== true || event.status === 'cancelled') {
    return fail(response, 409, 'self_checkin_off');
  }
  if (!beaconCodeValid(event.id, body.code)) {
    return fail(response, 400, 'checkin_code_invalid');
  }
  const mine = await attendance(event.id, session.user.id);
  if (!mine.going) {
    return fail(response, 409, 'not_going');
  }
  if (mine.checkedInAt) {
    return ok(response, { checkedInAt: mine.checkedInAt, already: true });
  }
  const now = new Date().toISOString();
  const { data, error } = await database()
    .from(TABLES.attendees)
    .update({ checked_in_at: now, checked_in_by: null, checked_in_how: 'self' })
    .eq('event_id', event.id)
    .eq('user_id', session.user.id)
    .is('checked_in_at', null)
    .select('checked_in_at');
  if (error) {
    throw error;
  }
  if (!Array.isArray(data) || data.length === 0) {
    const again = await attendance(event.id, session.user.id);
    return ok(response, { checkedInAt: again.checkedInAt, already: true });
  }
  await audit(request, { action: 'checkin.self', actorId: session.user.id, eventId: event.id, details: { rsvpNumber: mine.rsvpNumber } });
  return ok(response, { checkedInAt: now, already: false });
});
