// POST /api/manage/cover { id, image, sourceImageId, crop }   set an event's cover picture
// POST /api/manage/cover { id, remove: true }   take it off
//
// Editors and admins only. image is a base64 WebP the browser made
// (js/cover-upload.js); covers.js checks and re-encodes it before it goes to
// the gftvevents_covers bucket. The old picture is deleted after the event
// points at the new one. -> { event: { coverImageUrl, hasCover,
// coverSourceId, coverCrop } }, all the edit form redraws (serialize.js
// managedCover).
//
// The cover is cut from a gallery picture (migrations/019): sourceImageId is
// that picture, which must be in this event's gallery, and crop the part
// kept ({ x, y, width, height } in its pixels, inside it), both kept on the
// event so "Adjust crop" can start from them later. Without them the cover
// is saved with no source, as before the gallery.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { managedCover } from '../_lib/serialize.js';
import { prepareCover, storeCover, deleteCover, MAX_UPLOAD_BYTES } from '../_lib/covers.js';
import { galleryRow } from '../_lib/gallery.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Base64 is four characters for every three bytes; the 4 KB on top is room
// for the rest of the JSON body.
const MAX_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4096;

// A crop of a picture width by height: four finite numbers, inside it (to
// within a pixel, for rounding), at least a pixel wide and high. Rounded to
// tenths of a pixel. null when it is not one.
function cropInside(crop, width, height) {
  if (!crop || typeof crop !== 'object') {
    return null;
  }
  const values = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(crop[key]);
    if (typeof crop[key] !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    values[key] = Math.round(value * 10) / 10;
  }
  if (values.x < -1 || values.y < -1 || values.width < 1 || values.height < 1) {
    return null;
  }
  if (values.x + values.width > width + 1 || values.y + values.height > height + 1) {
    return null;
  }
  return values;
}

// Where a new cover was cut from: { sourceId, crop }, both null when the
// body names no gallery picture, or { error } for one that is not this
// event's, or a crop that does not fit it.
async function coverSource(body, eventId) {
  if (body.sourceImageId === null || body.sourceImageId === undefined || body.sourceImageId === '') {
    return { sourceId: null, crop: null };
  }
  if (!UUID_PATTERN.test(String(body.sourceImageId))) {
    return { error: 'bad_request' };
  }
  const image = await galleryRow(eventId, String(body.sourceImageId).toLowerCase());
  if (!image) {
    return { error: 'gallery_image_gone' };
  }
  const crop = cropInside(body.crop, image.width, image.height);
  if (!crop) {
    return { error: 'bad_request' };
  }
  return { sourceId: image.id, crop };
}

// Stores the new picture (or none), points the event at it, then deletes the
// old one. If the event cannot be saved, the new picture is deleted instead.
export default route('manage/cover', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  if (await limited(request, response, 'cover', [`u:${session.user.id}`])) {
    return;
  }
  const body = await readJson(request, response, { maxBytes: MAX_BODY_BYTES });
  if (!body) {
    return;
  }
  let typedId = '';
  if (body.id !== null && body.id !== undefined) {
    typedId = body.id;
  }
  if (!UUID_PATTERN.test(String(typedId))) {
    return fail(response, 400, 'bad_request');
  }
  // An editor of one event (migrations/018): only its own.
  if (!(await canEditEvent(session.user, String(typedId).toLowerCase()))) {
    return fail(response, 404, 'not_found');
  }

  const { data: event, error } = await database()
    .from(TABLES.events)
    .select('id, slug, cover_image_path')
    .eq('id', body.id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  let previousPath = null;
  if (event.cover_image_path) {
    previousPath = event.cover_image_path;
  }

  let path = null;
  let bytes = 0;
  let source = { sourceId: null, crop: null };
  if (body.remove !== true) {
    source = await coverSource(body, event.id);
    if (source.error) {
      return fail(response, 400, source.error);
    }
    const prepared = await prepareCover(body.image);
    if (!prepared.ok) {
      return fail(response, 400, prepared.error);
    }
    bytes = prepared.buffer.length;
    path = await storeCover(event.id, prepared.buffer);
  }

  const { data: saved, error: saveError } = await database()
    .from(TABLES.events)
    .update({ cover_image_path: path, cover_source_image_id: source.sourceId, cover_crop: source.crop, updated_by: session.user.id })
    .eq('id', event.id)
    .select('slug, cover_image_path, cover_source_image_id, cover_crop')
    .single();
  if (saveError) {
    await deleteCover(path);
    throw saveError;
  }
  await deleteCover(previousPath);
  let auditAction = 'event.cover_removed';
  if (path) {
    auditAction = 'event.cover_set';
  }
  await audit(request, { action: auditAction, actorId: session.user.id, eventId: event.id, details: { bytes, fromGallery: Boolean(source.sourceId) } });
  ok(response, { event: managedCover(saved) });
});
