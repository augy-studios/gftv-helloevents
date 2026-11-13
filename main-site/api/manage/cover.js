// POST /api/manage/cover { id, image }   set an event's cover picture
// POST /api/manage/cover { id, remove: true }   take it off
//
// Editors and admins only. image is a base64 WebP the browser made
// (js/cover-upload.js); covers.js checks and re-encodes it before it goes to
// the gftvevents_covers bucket. The old picture is deleted after the event
// points at the new one. -> { event: { coverImageUrl, hasCover } }, all the
// edit form redraws (serialize.js managedCover).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { managedCover } from '../_lib/serialize.js';
import { prepareCover, storeCover, deleteCover, MAX_UPLOAD_BYTES } from '../_lib/covers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Base64 is four characters for every three bytes; the 4 KB on top is room
// for the rest of the JSON body.
const MAX_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4096;

// Stores the new picture (or none), points the event at it, then deletes the
// old one. If the event cannot be saved, the new picture is deleted instead.
export default route('manage/cover', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true });
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

  const { data: event, error } = await database()
    .from(TABLES.events)
    .select('id, cover_image_path')
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
  if (body.remove !== true) {
    const prepared = await prepareCover(body.image);
    if (!prepared.ok) {
      return fail(response, 400, prepared.error);
    }
    bytes = prepared.buffer.length;
    path = await storeCover(event.id, prepared.buffer);
  }

  const { data: saved, error: saveError } = await database()
    .from(TABLES.events)
    .update({ cover_image_path: path, updated_by: session.user.id })
    .eq('id', event.id)
    .select('cover_image_path')
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
  await audit(request, { action: auditAction, actorId: session.user.id, eventId: event.id, details: { bytes } });
  ok(response, { event: managedCover(saved) });
});
