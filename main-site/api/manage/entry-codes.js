// The organisers' own entry QR codes (migrations/027, entry-codes.js), on
// the edit form's ID verification tab. The event's editors only.
//
// GET  ?id=<event id>                 -> { codes }
// GET  ?id=&code=<code id>&image=1    the code's picture (never cached)
// POST { action: "add", id, image }   -> { codes }  image: a base64 PNG
//        (js/picture-file.js), kept lossless so it still scans. In shared
//        mode one code is kept: adding replaces it.
// POST { action: "remove", id, code } -> { codes }
// POST { action: "assign", id, code, rsvpNumber }  -> { codes }
//        hands a code to the person with that RSVP ID (null frees it); one
//        code per person, so the one they held is freed
//
// codes: [{ id, imageUrl, position, holder }] with holder the person it is
// handed to ({ rsvpNumber, username, displayName }) or null.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { preparePicture, storeEntryCode, deletePaymentFiles, readPaymentFile, MAX_QR_BYTES } from '../_lib/payments.js';
import { entryCodes, handOut } from '../_lib/entry-codes.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = Math.ceil((MAX_QR_BYTES * 4) / 3) + 4096;
const MAX_CODES = 1000;
const EVENT_COLUMNS = 'id, slug, starts_at, entry_qr_mode, entry_qr_audience, entry_qr_show, entry_qr_hours';

async function loadEvent(eventId) {
  const { data, error } = await database().from(TABLES.events).select(EVENT_COLUMNS).eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The event's attendees, by account id: RSVP ID and names.
async function holders(eventId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`user_id, rsvp_number, account:${TABLES.accounts}!user_id ( kind, username, display_name, staff:${TABLES.users} ( username, display_name ) )`)
    .eq('event_id', eventId)
    .limit(5000);
  if (error) {
    throw error;
  }
  const byAccount = new Map();
  if (Array.isArray(data)) {
    for (const row of data) {
      let account = row.account;
      if (!account) {
        account = {};
      }
      let person = account;
      if (account.kind === 'staff') {
        person = account.staff;
        if (!person) {
          person = {};
        }
      }
      let displayName = person.display_name;
      if (!displayName) {
        displayName = person.username;
      }
      byAccount.set(row.user_id, { userId: row.user_id, rsvpNumber: row.rsvp_number, username: person.username, displayName });
    }
  }
  return byAccount;
}

async function codesAnswer(event) {
  await handOut(event);
  const people = await holders(event.id);
  const codes = await entryCodes(event.id);
  return codes.map((code) => {
    let holder = null;
    const person = people.get(code.assigned_to);
    if (person) {
      holder = { rsvpNumber: person.rsvpNumber, username: person.username, displayName: person.displayName };
    }
    return { id: code.id, imageUrl: `/api/manage/entry-codes?id=${event.id}&code=${code.id}&image=1`, position: code.position, holder };
  });
}

async function addCode(request, response, event, body, user) {
  const prepared = await preparePicture(body.image, 'qr');
  if (!prepared.ok) {
    return fail(response, 400, prepared.error);
  }
  const existing = await entryCodes(event.id);
  if (existing.length >= MAX_CODES) {
    return fail(response, 409, 'entry_codes_full');
  }
  const path = await storeEntryCode(event.id, prepared.buffer);
  let position = 0;
  if (existing.length > 0) {
    position = existing[existing.length - 1].position + 1;
  }
  const { error } = await database().from(TABLES.entryCodes).insert({ event_id: event.id, path, position });
  if (error) {
    await deletePaymentFiles([path]);
    throw error;
  }
  // One shared code: the new one replaces the rest.
  if (event.entry_qr_mode === 'shared') {
    for (const old of existing) {
      await database().from(TABLES.entryCodes).delete().eq('id', old.id);
    }
    await deletePaymentFiles(existing.map((old) => old.path));
  }
  await audit(request, { action: 'entry_code.added', actorId: user.id, eventId: event.id });
  return ok(response, { codes: await codesAnswer(event) });
}

async function removeCode(request, response, event, body, user) {
  const codes = await entryCodes(event.id);
  const code = codes.find((each) => each.id === String(body.code).toLowerCase());
  if (!code) {
    return fail(response, 404, 'not_found');
  }
  const { error } = await database().from(TABLES.entryCodes).delete().eq('id', code.id);
  if (error) {
    throw error;
  }
  await deletePaymentFiles([code.path]);
  await audit(request, { action: 'entry_code.removed', actorId: user.id, eventId: event.id });
  return ok(response, { codes: await codesAnswer(event) });
}

async function assignCode(request, response, event, body, user) {
  const codes = await entryCodes(event.id);
  const code = codes.find((each) => each.id === String(body.code).toLowerCase());
  if (!code) {
    return fail(response, 404, 'not_found');
  }
  let holder = null;
  if (body.rsvpNumber !== null && body.rsvpNumber !== undefined && body.rsvpNumber !== '') {
    const number = Number(String(body.rsvpNumber).replace(/^#/, ''));
    const person = [...(await holders(event.id)).values()].find((each) => each.rsvpNumber === number);
    if (!person) {
      return fail(response, 404, 'checkin_not_found');
    }
    holder = person.userId;
  }
  if (holder) {
    // One code per person: the one they held is freed.
    const { error: freeError } = await database().from(TABLES.entryCodes).update({ assigned_to: null }).eq('event_id', event.id).eq('assigned_to', holder);
    if (freeError) {
      throw freeError;
    }
  }
  const { error } = await database().from(TABLES.entryCodes).update({ assigned_to: holder }).eq('id', code.id);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'entry_code.assigned', actorId: user.id, eventId: event.id, details: { code: code.id } });
  return ok(response, { codes: await codesAnswer(event) });
}

export default route('manage/entry-codes', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  const user = session.user;
  let body = null;
  let eventId = query(request, 'id');
  if (request.method === 'POST') {
    body = await readJson(request, response, { maxBytes: MAX_BODY_BYTES });
    if (!body) {
      return;
    }
    if (await limited(request, response, 'payment', [`u:${user.id}`])) {
      return;
    }
    eventId = String(body.id);
  }
  if (!UUID_PATTERN.test(eventId)) {
    return fail(response, 400, 'bad_request');
  }
  eventId = eventId.toLowerCase();
  if (!(await canEditEvent(user, eventId))) {
    return fail(response, 404, 'not_found');
  }
  const event = await loadEvent(eventId);
  if (!event) {
    return fail(response, 404, 'not_found');
  }

  if (request.method === 'GET') {
    const codeId = query(request, 'code');
    if (codeId && query(request, 'image') === '1') {
      response.setHeader('Cache-Control', 'no-store, private');
      const code = (await entryCodes(event.id)).find((each) => each.id === codeId.toLowerCase());
      let file = null;
      if (code) {
        file = await readPaymentFile(code.path);
      }
      if (!file) {
        return fail(response, 404, 'not_found');
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', file.type);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      return response.end(file.bytes);
    }
    return ok(response, { codes: await codesAnswer(event) });
  }

  if (body.action === 'add') {
    return addCode(request, response, event, body, user);
  }
  if (body.action === 'remove') {
    return removeCode(request, response, event, body, user);
  }
  if (body.action === 'assign') {
    return assignCode(request, response, event, body, user);
  }
  return fail(response, 400, 'bad_request');
});
