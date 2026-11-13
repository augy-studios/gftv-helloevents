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

// Finds the event (any status for an editor, released ones for everyone
// else) and answers with what this viewer may see of it.
export default route('events/detail', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const session = await currentSession(request);
  let isManager = false;
  if (session && canManage(session.user)) {
    isManager = true;
  }

  let row;
  if (isManager) {
    row = await anyEventBySlug(slug, DETAIL_COLUMNS);
  } else {
    row = await releasedEventBySlug(slug);
  }
  if (!row) {
    return fail(response, 404, 'not_found');
  }

  let going = false;
  if (session) {
    going = await isGoing(row.id, session.user.id);
  }
  const event = publicEventDetail(row, { signedIn: Boolean(session), going, canManage: isManager });
  // Only an editor ever sees an unreleased event, and is told so: a draft,
  // or one whose release time is still to come.
  let preview = false;
  if (isManager) {
    if (row.status === 'draft') {
      preview = true;
    } else if (row.publish_at && new Date(row.publish_at) > new Date()) {
      preview = true;
    }
  }
  ok(response, { event, preview });
});
