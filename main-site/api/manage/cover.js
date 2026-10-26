// POST /api/manage/cover { id, image }   set an event's cover picture
// POST /api/manage/cover { id, remove: true }   take it off
//
// Editors and admins only. image is a base64 WebP the browser made
// (js/cover-upload.js); covers.js checks and re-encodes it before it goes to
// the gftvevents_covers bucket. The old picture is deleted after the event
// points at the new one. -> { event } (the editor view)

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { MANAGE_COLUMNS } from '../_lib/events.js';
import { managedEvent } from '../_lib/serialize.js';
import { prepareCover, storeCover, deleteCover, MAX_UPLOAD_BYTES } from '../_lib/covers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default route('manage/cover', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const session = await requireUser(req, res, { manage: true });
  if (!session) return;
  if (await limited(req, res, 'cover', [`u:${session.user.id}`])) return;
  const body = await readJson(req, res, { maxBytes: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4096 });
  if (!body) return;
  if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');

  const { data: event, error } = await db().from(T.events).select('id, cover_image_path').eq('id', body.id).maybeSingle();
  if (error) throw error;
  if (!event) return fail(res, 404, 'not_found');
  const previous = event.cover_image_path || null;

  let path = null;
  let bytes = 0;
  if (body.remove !== true) {
    const prepared = await prepareCover(body.image);
    if (!prepared.ok) return fail(res, 400, prepared.error);
    bytes = prepared.buffer.length;
    path = await storeCover(event.id, prepared.buffer);
  }

  const { data: saved, error: saveError } = await db()
    .from(T.events)
    .update({ cover_image_path: path, updated_by: session.user.id })
    .eq('id', event.id)
    .select(MANAGE_COLUMNS)
    .single();
  if (saveError) {
    await deleteCover(path);
    throw saveError;
  }
  await deleteCover(previous);
  await audit(req, { action: path ? 'event.cover_set' : 'event.cover_removed', actorId: session.user.id, eventId: event.id, details: { bytes } });
  ok(res, { event: managedEvent(saved) });
});
