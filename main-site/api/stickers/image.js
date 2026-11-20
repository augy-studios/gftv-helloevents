// GET /api/stickers/image?id=<sticker id>&v=<file name>
//
// A sticker's file (migrations/020): its WebP, its WebM, or a video
// sticker's still WebP, from the private gftvevents_stickers bucket. v is
// the stored file's own random name, so an address always serves the same
// bytes: cached by the browser and the CDN for a long time. Stickers are
// copies of public Telegram stickers and appear in public descriptions, so
// anyone with the address may load one. Anything else is 404, not cached.

import { route, guard, fail, query } from '../_lib/http.js';
import { stickerById, stickerFileFor, readStickerFile } from '../_lib/stickers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

export default route('stickers/image', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const id = query(request, 'id').toLowerCase();
  const version = query(request, 'v');
  if (!UUID_PATTERN.test(id) || !version) {
    return notFound(response);
  }
  const sticker = await stickerById(id);
  if (!sticker) {
    return notFound(response);
  }
  const path = stickerFileFor(sticker, version);
  if (!path) {
    return notFound(response);
  }
  const bytes = await readStickerFile(path);
  if (!bytes) {
    return notFound(response);
  }
  let contentType = 'image/webp';
  if (path.endsWith('.webm')) {
    contentType = 'video/webm';
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(bytes.length));
  response.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=31536000, immutable');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(bytes);
});
