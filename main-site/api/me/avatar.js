// GET /api/me/avatar?v=<version>
//
// The signed-in staff member's profile picture (set on gftv.asia), served
// from this site, so the Storage address it lives at never reaches a
// browser (serialize.js selfView avatarUrl). Only a picture stored in this
// site's own Supabase project is fetched (users.js avatarSource), never any
// other address, at most MAX_BYTES and only an image. v changes with the
// picture, so the browser keeps it a day; it is per person, so never on the
// CDN.

import { route, guard, fail } from '../_lib/http.js';
import { requireUser } from '../_lib/session.js';
import { avatarSource } from '../_lib/users.js';
import { errorDetail } from '../_lib/http.js';

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 5000;

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

export default route('me/avatar', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const source = avatarSource(session.user);
  if (!source) {
    return notFound(response);
  }
  let picture;
  try {
    picture = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    console.warn('[helloevents] avatar:', errorDetail(cause));
    return notFound(response);
  }
  const type = String(picture.headers.get('content-type'));
  if (!picture.ok || !/^image\/(png|jpeg|webp|gif|avif)$/.test(type.split(';')[0].trim())) {
    return notFound(response);
  }
  const bytes = Buffer.from(await picture.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    return notFound(response);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', type.split(';')[0].trim());
  response.setHeader('Content-Length', String(bytes.length));
  response.setHeader('Cache-Control', 'private, max-age=86400');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(bytes);
});
