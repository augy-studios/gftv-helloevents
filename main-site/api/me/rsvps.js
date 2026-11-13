// GET /api/me/rsvps -> { upcoming: [{ event }], past: [{ event }] }
//
// The signed-in person's RSVPs, as event cards: upcoming ones by start time,
// past ones newest RSVP first. An event that has since been moved back to
// draft, or had its release time pushed into the future, drops out of this
// list like it drops out of the feed.

import { route, guard, ok } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireUser } from '../_lib/session.js';
import { isReleased, isOver } from '../_lib/event-rules.js';
import { CARD_COLUMNS } from '../_lib/events.js';
import { myRsvpView } from '../_lib/serialize.js';

// Reads the person's RSVPs (newest first, at most 200), keeps the released
// events, and splits them into upcoming and past.
export default route('me/rsvps', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }

  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`event:${TABLES.events} ( ${CARD_COLUMNS} )`)
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    throw error;
  }

  const now = Date.now();
  let rsvpRows = [];
  if (data !== null && data !== undefined) {
    rsvpRows = data;
  }
  const rows = rsvpRows.filter((row) => {
    if (row.event && isReleased(row.event, now)) {
      return true;
    }
    return false;
  });
  // Upcoming RSVPs go soonest first; one with no start time yet goes last.
  const startTime = (row) => {
    if (row.event.starts_at) {
      return new Date(row.event.starts_at).getTime();
    }
    return Infinity;
  };
  const upcoming = rows
    .filter((row) => !isOver(row.event, now))
    .sort((first, second) => startTime(first) - startTime(second));
  const past = rows.filter((row) => isOver(row.event, now));
  ok(response, {
    upcoming: upcoming.map((row) => myRsvpView(row, now)),
    past: past.map((row) => myRsvpView(row, now)),
  });
});
