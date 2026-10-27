// GET /api/events/detail?slug=<slug>
//
// One event page. Anyone may read a released event. What they see depends on
// who they are (serialize.js publicEventDetail): the online link and an
// attendees-only address go to people going and to editors. Editors may also
// open an unreleased event, to preview it; everyone else gets 404 for it,
// exactly as for an event that does not exist.
//
// Never cached by the CDN, since the answer differs per person.

import { route, guard, ok, fail, query } from '../_lib/http.js';
import { currentSession } from '../_lib/session.js';
import { canManage } from '../_lib/users.js';
import { releasedEventBySlug, anyEventBySlug, isGoing, DETAIL_COLUMNS } from '../_lib/events.js';
import { publicEventDetail } from '../_lib/serialize.js';

export default route('events/detail', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const slug = query(req, 'slug').toLowerCase();
  const session = await currentSession(req);
  const manager = Boolean(session && canManage(session.user));

  const row = manager ? await anyEventBySlug(slug, DETAIL_COLUMNS) : await releasedEventBySlug(slug);
  if (!row) return fail(res, 404, 'not_found');

  const going = session ? await isGoing(row.id, session.user.id) : false;
  ok(res, {
    event: publicEventDetail(row, { signedIn: Boolean(session), going, canManage: manager }),
    // Only an editor ever sees an unreleased event, and is told so.
    preview: manager ? row.status === 'draft' || Boolean(row.publish_at && new Date(row.publish_at) > new Date()) : false,
  });
});
