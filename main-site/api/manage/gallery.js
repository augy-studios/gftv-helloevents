// GET  /api/manage/gallery?id=<event id>          the event's gallery pictures
// POST /api/manage/gallery { id, image }          add a picture
// POST /api/manage/gallery { id, imageUrl }       copy a picture from another website
// POST /api/manage/gallery { id, remove: <image id> }   take one out
//
// An event's picture gallery (migrations/019, api/_lib/gallery.js). Editors
// and admins, and editors of this one event, as for the cover. image is a
// base64 WebP the browser made (js/gallery-upload.js), in its own shape;
// covers.js checks and re-encodes it like a cover, with the gallery's
// limits, before it goes to the gftvevents_covers bucket. An event holds at
// most GALLERY_LIMIT pictures.
//
// imageUrl is a picture on another website, from a description pasted with
// pictures in it (the site shows only pictures it stores): the server
// fetches it (fetch-picture.js, which refuses private addresses), and it is
// re-encoded the same way.
//
// Every answer carries { images: [{ id, url, width, height }], limit }, the
// whole gallery as it now stands (serialize.js managedGalleryImage), oldest
// first. Taking out the picture the cover was cut from keeps the cover and
// forgets its source, so a removal also answers { event: managedCover }.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { managedCover, managedGalleryImage } from '../_lib/serialize.js';
import { prepareGalleryPicture, prepareCopiedPicture, storeCover, deleteCover, MAX_UPLOAD_BYTES } from '../_lib/covers.js';
import { fetchPicture } from '../_lib/fetch-picture.js';
import { galleryRows, galleryRow, GALLERY_LIMIT } from '../_lib/gallery.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Base64 is four characters for every three bytes; the 4 KB on top is room
// for the rest of the JSON body.
const MAX_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4096;

function isUuid(value) {
  let text = '';
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  return UUID_PATTERN.test(text);
}

// The event, if this person may edit it: { id, slug }, or null.
async function editableEvent(user, eventId) {
  if (!isUuid(eventId)) {
    return null;
  }
  const id = String(eventId).toLowerCase();
  if (!(await canEditEvent(user, id))) {
    return null;
  }
  const { data, error } = await database()
    .from(TABLES.events)
    .select('id, slug, cover_image_path, cover_source_image_id, cover_crop')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The whole gallery, for every answer.
async function galleryAnswer(event) {
  const rows = await galleryRows(event.id);
  return { images: rows.map((row) => managedGalleryImage(row, event.slug)), limit: GALLERY_LIMIT };
}

// Stores the picture, then adds its row. If the row cannot be added, the
// file is deleted again.
async function addPicture(request, response, session, event, body) {
  const rows = await galleryRows(event.id);
  if (rows.length >= GALLERY_LIMIT) {
    return fail(response, 400, 'gallery_full', { limit: GALLERY_LIMIT });
  }
  let prepared;
  if (typeof body.imageUrl === 'string' && body.imageUrl !== '') {
    let bytes;
    try {
      bytes = await fetchPicture(body.imageUrl.slice(0, 4000));
    } catch (error) {
      if (['picture_address_refused', 'picture_not_image', 'cover_too_large', 'picture_fetch_failed'].includes(error.code)) {
        return fail(response, 400, error.code);
      }
      throw error;
    }
    prepared = await prepareCopiedPicture(bytes);
  } else {
    prepared = await prepareGalleryPicture(body.image);
  }
  if (!prepared.ok) {
    return fail(response, 400, prepared.error);
  }
  const path = await storeCover(event.id, prepared.buffer);
  const { data: image, error } = await database()
    .from(TABLES.eventImages)
    .insert({ event_id: event.id, path, width: prepared.width, height: prepared.height, created_by: session.user.id })
    .select('id, event_id, path, width, height, created_at')
    .single();
  if (error) {
    await deleteCover(path);
    throw error;
  }
  await audit(request, { action: 'event.gallery_added', actorId: session.user.id, eventId: event.id, details: { bytes: prepared.buffer.length, copied: typeof body.imageUrl === 'string' } });
  return ok(response, { image: managedGalleryImage(image, event.slug), ...(await galleryAnswer(event)) });
}

// Deletes the row (the cover's source, if it was, is set null by the
// foreign key), then the file.
async function removePicture(request, response, session, event, imageId) {
  if (!isUuid(imageId)) {
    return fail(response, 400, 'bad_request');
  }
  const image = await galleryRow(event.id, String(imageId).toLowerCase());
  if (!image) {
    return fail(response, 404, 'not_found');
  }
  const { error } = await database().from(TABLES.eventImages).delete().eq('id', image.id).eq('event_id', event.id);
  if (error) {
    throw error;
  }
  await deleteCover(image.path);
  await audit(request, { action: 'event.gallery_removed', actorId: session.user.id, eventId: event.id });
  const fresh = await editableEvent(session.user, event.id);
  let shown = event;
  if (fresh) {
    shown = fresh;
  }
  return ok(response, { event: managedCover(shown), ...(await galleryAnswer(shown)) });
}

export default route('manage/gallery', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }

  if (request.method === 'GET') {
    const event = await editableEvent(session.user, query(request, 'id'));
    if (!event) {
      return fail(response, 404, 'not_found');
    }
    return ok(response, await galleryAnswer(event));
  }

  if (await limited(request, response, 'gallery', [`u:${session.user.id}`])) {
    return;
  }
  const body = await readJson(request, response, { maxBytes: MAX_BODY_BYTES });
  if (!body) {
    return;
  }
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  // An editor of one event (migrations/018): only its own.
  const event = await editableEvent(session.user, body.id);
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  if (body.remove !== null && body.remove !== undefined) {
    return removePicture(request, response, session, event, body.remove);
  }
  return addPicture(request, response, session, event, body);
});
