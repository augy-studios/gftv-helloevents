// The organisers' own entry QR codes (migrations/027): a cinema's tickets,
// a venue's pass. Uploaded on the edit form's ID verification and entry tab
// (api/manage/entry-codes.js), kept as lossless PNGs in the private
// payments bucket, and shown on the event page to the people going who
// qualify (api/events/entry-code.js).
//
//   events.entry_qr_mode      off, shared (one code everyone sees) or each
//                             (one per person)
//   events.entry_qr_audience  all going, or only paid (a confirmed payment)
//   events.entry_qr_show      always, before (from entry_qr_hours before the
//                             start) or checked_in
//
// In "each" mode codes are handed out one per person, in RSVP order, to the
// people who qualify (handOut, run whenever someone asks for theirs and when
// codes are added); a code held by someone no longer going is freed first.
// Organisers can hand a code to someone else by hand.

import { database, TABLES } from './supabase.js';

const CODE_COLUMNS = 'id, event_id, path, position, assigned_to, created_at';

export async function entryCodes(eventId) {
  const { data, error } = await database()
    .from(TABLES.entryCodes)
    .select(CODE_COLUMNS)
    .eq('event_id', eventId)
    .order('position', { ascending: true })
    .limit(2000);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data;
}

function hoursOf(row) {
  if (Number.isInteger(row.entry_qr_hours)) {
    return row.entry_qr_hours;
  }
  return 2;
}

// Whether an attendee row qualifies for the event's entry code now:
// { ok: true } or { ok: false, why } with why 'unpaid', 'later' (from: when)
// or 'checkin'. row: the attendee's payment_status and checked_in_at.
export function entryQualifies(event, row, now = Date.now()) {
  if (event.entry_qr_audience === 'paid' && row.payment_status !== 'paid') {
    return { ok: false, why: 'unpaid' };
  }
  if (event.entry_qr_show === 'before' && event.starts_at) {
    const from = new Date(event.starts_at).getTime() - hoursOf(event) * 3600_000;
    if (now < from) {
      return { ok: false, why: 'later', from: new Date(from).toISOString() };
    }
  }
  if (event.entry_qr_show === 'checked_in' && !row.checked_in_at) {
    return { ok: false, why: 'checkin' };
  }
  return { ok: true };
}

// Hands the free codes of an "each" event to the people who qualify and
// hold none, in RSVP order, after freeing codes held by people no longer
// going. Two people asking at once cannot get the same code: a code is
// taken only while still free, and one person can hold only one (a unique
// index).
export async function handOut(event, now = Date.now()) {
  if (event.entry_qr_mode !== 'each') {
    return;
  }
  const codes = await entryCodes(event.id);
  if (codes.length === 0) {
    return;
  }
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select('user_id, rsvp_number, payment_status, checked_in_at')
    .eq('event_id', event.id)
    .order('rsvp_number', { ascending: true })
    .limit(5000);
  if (error) {
    throw error;
  }
  let attendees = [];
  if (Array.isArray(data)) {
    attendees = data;
  }
  const going = new Set(attendees.map((row) => row.user_id));
  for (const code of codes) {
    if (code.assigned_to && !going.has(code.assigned_to)) {
      const { error: freeError } = await database().from(TABLES.entryCodes).update({ assigned_to: null }).eq('id', code.id).eq('assigned_to', code.assigned_to);
      if (freeError) {
        throw freeError;
      }
      code.assigned_to = null;
    }
  }
  const holding = new Set(codes.filter((code) => code.assigned_to).map((code) => code.assigned_to));
  const free = codes.filter((code) => !code.assigned_to);
  const waiting = attendees.filter((row) => {
    if (holding.has(row.user_id)) {
      return false;
    }
    return entryQualifies(event, row, now).ok;
  });
  for (const row of waiting) {
    const code = free.shift();
    if (!code) {
      return;
    }
    const { data: taken, error: takeError } = await database()
      .from(TABLES.entryCodes)
      .update({ assigned_to: row.user_id })
      .eq('id', code.id)
      .is('assigned_to', null)
      .select('id');
    // Someone else took it, or this person got one meanwhile: next time.
    if (takeError || !Array.isArray(taken) || taken.length === 0) {
      continue;
    }
  }
}

// What the person going sees about the entry code: null when the event has
// none for them; else { state, url, from }. state: ready (url: the picture),
// unpaid, later (from: when it shows), checkin, or none_left (every code is
// handed out).
export async function entryForViewer(event, accountId, attendeeRow, now = Date.now()) {
  if (!event.entry_qr_mode || event.entry_qr_mode === 'off' || !attendeeRow) {
    return null;
  }
  const qualifies = entryQualifies(event, attendeeRow, now);
  if (!qualifies.ok) {
    let from = null;
    if (qualifies.from) {
      from = qualifies.from;
    }
    return { state: qualifies.why, url: null, from };
  }
  if (event.entry_qr_mode === 'each') {
    await handOut(event, now);
  }
  const codes = await entryCodes(event.id);
  let code;
  if (event.entry_qr_mode === 'shared') {
    code = codes[0];
  } else {
    code = codes.find((each) => each.assigned_to === accountId);
  }
  if (!code) {
    if (event.entry_qr_mode === 'shared') {
      return null;
    }
    return { state: 'none_left', url: null, from: null };
  }
  return { state: 'ready', url: entryCodeUrl(event.slug, code.id), from: null };
}

export function entryCodeUrl(slug, codeId) {
  return `/api/events/entry-code?slug=${encodeURIComponent(slug)}&v=${encodeURIComponent(codeId)}`;
}
