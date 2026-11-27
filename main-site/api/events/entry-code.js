// GET /api/events/entry-code?slug=<slug>&v=<code id>
//
// An organiser's entry QR code (migrations/027, entry-codes.js), as a
// picture, for the person going it is for: the event's shared code, or the
// one handed to them, while they qualify (paid, when only paid people get
// it; from the time it shows; once checked in, when it waits for that).
// The event's editors can open any. Never cached by a shared cache: the
// page keeps its own copy for when the connection drops.

import { route, guard, fail, query } from '../_lib/http.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { releasedEventBySlug, anyEventBySlug, DETAIL_COLUMNS } from '../_lib/events.js';
import { database, TABLES } from '../_lib/supabase.js';
import { readPaymentFile } from '../_lib/payments.js';
import { entryCodes, entryQualifies } from '../_lib/entry-codes.js';

function notFound(response) {
  return fail(response, 404, 'not_found');
}

export default route('events/entry-code', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  response.setHeader('Cache-Control', 'no-store, private');
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const codeId = query(request, 'v').toLowerCase();
  let event = await releasedEventBySlug(slug);
  let editor = false;
  if (!event) {
    event = await anyEventBySlug(slug, DETAIL_COLUMNS);
  }
  if (!event) {
    return notFound(response);
  }
  if (await canEditEvent(session.user, event.id)) {
    editor = true;
  }
  const code = (await entryCodes(event.id)).find((each) => each.id === codeId);
  if (!code) {
    return notFound(response);
  }
  if (!editor) {
    if (!event.entry_qr_mode || event.entry_qr_mode === 'off') {
      return notFound(response);
    }
    const { data: mine, error } = await database()
      .from(TABLES.attendees)
      .select('payment_status, checked_in_at')
      .eq('event_id', event.id)
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (!mine || !entryQualifies(event, mine).ok) {
      return notFound(response);
    }
    if (event.entry_qr_mode === 'each' && code.assigned_to !== session.user.id) {
      return notFound(response);
    }
  }
  const file = await readPaymentFile(code.path);
  if (!file) {
    return notFound(response);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', file.type);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(file.bytes);
});
