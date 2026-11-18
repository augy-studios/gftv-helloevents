// GET /api/events/embed-image?slug=<slug>&v=<cover name>
//
// A released event's cover picture as a JPEG, for link previews (page.js puts
// this address in the event page's og:image). Covers are stored as WebP,
// which not every app that unfurls links reads.
//
// v is the stored cover's own name (covers.js coverVersion), which changes
// with every upload, so an answer never changes for an address and is cached
// for a year. An address whose v is not the current cover's, or whose event
// is not released or has no cover, gets 404, so an old address never caches
// the new picture and an unreleased event's cover is not served.

import { route, guard, fail, query } from '../_lib/http.js';
import { releasedEventBySlug } from '../_lib/events.js';
import { coverVersion, readCover, embedPicture } from '../_lib/covers.js';

export default route('events/embed-image', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const version = query(request, 'v');
  const row = await releasedEventBySlug(slug);
  if (!row || !version || coverVersion(row.cover_image_path) !== version) {
    return fail(response, 404, 'not_found');
  }
  const bytes = await readCover(row.cover_image_path);
  if (!bytes) {
    return fail(response, 404, 'not_found');
  }
  const picture = await embedPicture(bytes);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'image/jpeg');
  response.setHeader('Content-Length', String(picture.length));
  response.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(picture);
});
