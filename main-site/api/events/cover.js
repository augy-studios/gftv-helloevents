// GET /api/events/cover?slug=<slug>&v=<cover name>
//
// An event's cover picture, served from this site, so the address of the
// Storage bucket it lives in never reaches a browser: every page shows
// covers from here (serialize.js coverImageUrl). The picture goes out as it
// is stored, a WebP already re-encoded and stripped of metadata on upload
// (covers.js).
//
// v is the stored cover's own name (covers.js coverVersion), which changes
// with every upload, so an answer never changes for an address:
//   - a released event's cover is public, cached by the browser and the CDN
//     for a long time;
//   - an unreleased event's cover (a draft, or a release time still to come)
//     goes only to an editor, never cached, as the edit form and preview
//     show it;
//   - anything else (no such event, no cover, an old v, an unreleased event
//     for anyone else) gets 404, not cached, so a later release or upload is
//     seen at once and an unreleased event is not given away.

import { route, guard, fail, query } from '../_lib/http.js';
import { currentSession } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { isReleased } from '../_lib/event-rules.js';
import { anyEventBySlug } from '../_lib/events.js';
import { coverVersion, readCover } from '../_lib/covers.js';

const COLUMNS = 'id, slug, status, publish_at, cover_image_path';

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

export default route('events/cover', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const version = query(request, 'v');
  const row = await anyEventBySlug(slug, COLUMNS);
  if (!row || !version || coverVersion(row.cover_image_path) !== version) {
    return notFound(response);
  }
  const released = isReleased(row);
  if (!released) {
    const session = await currentSession(request);
    if (!session || !(await canEditEvent(session.user, row.id))) {
      return notFound(response);
    }
  }
  const bytes = await readCover(row.cover_image_path);
  if (!bytes) {
    return notFound(response);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'image/webp');
  response.setHeader('Content-Length', String(bytes.length));
  if (released) {
    response.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=31536000, immutable');
  } else {
    response.setHeader('Cache-Control', 'private, no-store');
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(bytes);
});
