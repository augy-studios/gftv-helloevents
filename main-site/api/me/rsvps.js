// GET /api/me/rsvps -> { upcoming: [...], past: [...] }
//
// The signed-in person's RSVPs, as event cards. An event that has since been
// moved back to draft, or had its release time pushed into the future, drops
// out of this list like it drops out of the feed.

import { route, guard, ok } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { requireUser } from '../_lib/session.js';
import { isReleased, isOver } from '../_lib/event-rules.js';
import { CARD_COLUMNS } from '../_lib/events.js';
import { myRsvpView } from '../_lib/serialize.js';

export default route('me/rsvps', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const session = await requireUser(req, res);
  if (!session) return;

  const { data, error } = await db()
    .from(T.attendees)
    .select(`created_at, event:${T.events} ( ${CARD_COLUMNS} )`)
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;

  const now = Date.now();
  const rows = (data ?? []).filter((row) => row.event && isReleased(row.event, now));
  const startOf = (row) => (row.event.starts_at ? new Date(row.event.starts_at).getTime() : Infinity);
  const upcoming = rows.filter((row) => !isOver(row.event, now)).sort((a, b) => startOf(a) - startOf(b));
  const past = rows.filter((row) => isOver(row.event, now));
  ok(res, { upcoming: upcoming.map((r) => myRsvpView(r, now)), past: past.map((r) => myRsvpView(r, now)) });
});
