// GET /api/events/gallery-image?slug=<slug>&v=<picture name>[&crop=x,y,width,height]
//
// One of an event's gallery pictures (migrations/019), served from this
// site, so the Storage bucket's address never reaches a browser. The same
// rules as the cover (api/events/cover.js):
//   - a released event's picture is public, cached by the browser and the
//     CDN for a long time (v is the file's own random name, so an address
//     always shows the same picture);
//   - an unreleased event's picture goes only to an editor, never cached;
//   - anything else (no such event or picture, a picture taken out, an
//     unreleased event for anyone else, a crop that is not one) gets 404,
//     not cached.
//
// crop is a description's own crop of the picture (js/rich-text.js
// parseCrop: fractions of the whole picture): that part is cut out and sent
// as a WebP. The address names the crop, so it is cached like the whole
// picture.

import { route, guard, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { currentSession } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { isReleased } from '../_lib/event-rules.js';
import { anyEventBySlug } from '../_lib/events.js';
import { readCover } from '../_lib/covers.js';
import { parseCrop, cropText } from '../../js/rich-text.js';
import sharp from 'sharp';

const COLUMNS = 'id, slug, status, publish_at';
const NAME = /^[A-Za-z0-9_-]{16,64}$/;

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

// The gallery row with this file, of this event, or null.
async function pictureOf(eventId, name) {
  const { data, error } = await database()
    .from(TABLES.eventImages)
    .select('id, path')
    .eq('event_id', eventId)
    .eq('path', `${eventId}/${name}.webp`)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The part of a stored gallery picture a crop names, as a WebP.
async function cropPicture(bytes, crop) {
  const image = sharp(bytes, { failOn: 'error' });
  const { width, height } = await image.metadata();
  const left = Math.min(width - 1, Math.round(crop.x * width));
  const top = Math.min(height - 1, Math.round(crop.y * height));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(crop.width * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(crop.height * height)));
  return image.extract({ left, top, width: cropWidth, height: cropHeight }).webp({ quality: 82 }).toBuffer();
}

export default route('events/gallery-image', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const name = query(request, 'v');
  if (!NAME.test(name)) {
    return notFound(response);
  }
  const row = await anyEventBySlug(slug, COLUMNS);
  if (!row) {
    return notFound(response);
  }
  const released = isReleased(row);
  if (!released) {
    const session = await currentSession(request);
    if (!session || !(await canEditEvent(session.user, row.id))) {
      return notFound(response);
    }
  }
  const picture = await pictureOf(row.id, name);
  if (!picture) {
    return notFound(response);
  }
  let crop = null;
  const cropQuery = query(request, 'crop');
  if (cropQuery) {
    crop = parseCrop(cropQuery);
    if (!crop || cropText(crop) !== cropQuery) {
      return notFound(response);
    }
  }
  let bytes = await readCover(picture.path);
  if (!bytes) {
    return notFound(response);
  }
  if (crop) {
    bytes = await cropPicture(bytes, crop);
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
