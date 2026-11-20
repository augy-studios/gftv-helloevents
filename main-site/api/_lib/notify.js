// Notifications about events, kept modest. Three kinds, each one a choice on
// the account page (gftvevents_accounts.notify_*):
//
//   updates    an event you are going to changes when or where it happens,
//              its timetable changes, or it is cancelled (sent shortly after
//              an editor saves the change, once for a run of saves:
//              queueEventChange below)
//   reminders  before an event you are going to, at the times the account
//              picked: 1, 2 or 3 hours, a day, a week (cron/notify.js, every
//              ten minutes; each time once per RSVP: sendReminders)
//   newEvents  a new event is announced, off by default (cron/notify.js,
//              once per event, when it is released)
//
// Plus one that is not a choice, as it answers something the person did:
// an editor confirmed the payment for their ticket (migrations/016,
// sendPaymentConfirmed).
//
// Each goes to the account's browsers by Web Push (push.js) and, when the
// account switched "also send to Telegram" on and has a linked chat, to the
// Telegram bot as a rich message.
//
// Only released events are ever announced, and a notice carries only what
// the public event page shows: title, when (unless to be announced), the
// place name and the page link. Never an online link or an attendees-only
// address; those stay on the event page for people going.
//
// The one exception is a reminder's Telegram message, which goes only to
// someone going, in their own linked chat: it carries what the event page
// shows them as someone going, every place with its street address and map
// link (the meeting point, a meal held somewhere else), and the online link.
// Its push notification, which can show on a locked screen, stays to the
// public when and where.

import { waitUntil } from '@vercel/functions';
import { database, TABLES } from './supabase.js';
import { siteUrl } from './env.js';
import { pushToAccount } from './push.js';
import { sendRichTelegram, telegramConfigured } from './telegram.js';
import { eventNoticeMessage, reminderMessage } from './telegram-messages.js';
import { reminderHoursFrom } from './users.js';
import { isReleased, datesAnnounced, storedLocations, storedMeals, storedTimetable } from './event-rules.js';
import { whenText, endText, placeText, countryText, untilText, startDateText, startTimeText } from './event-text.js';
import { embedImageUrl } from './covers.js';
import { errorDetail } from './http.js';

const CONCURRENCY = 8;
// The most accounts one "new event" run tells, so one cron run stays short.
export const MAX_ANNOUNCE = 2000;
// The furthest ahead a reminder can be (a week), and how early one may go:
// the cron runs every ten minutes (vercel.json), so a reminder goes between
// five minutes early and five minutes late.
export const REMIND_WITHIN_HOURS = 168;
export const REMINDER_LEAD_MS = 5 * 60_000;

// A query's rows, or an empty list when it gave back none (null).
function rowsOf(data) {
  if (data === null || data === undefined) {
    return [];
  }
  return data;
}

// Background work after a response, kept alive on Vercel with waitUntil.
// Tests await settle() to see it finish.
const pending = new Set();
export function background(promise) {
  const tracked = Promise.resolve(promise).catch((cause) => console.error('[helloevents] notify:', errorDetail(cause)));
  pending.add(tracked);
  tracked.finally(() => pending.delete(tracked));
  try {
    waitUntil(tracked);
  } catch {
    /* not on Vercel */
  }
  return tracked;
}
export async function settle() {
  while (pending.size) {
    await Promise.all([...pending]);
  }
}

// The notice for one event, from public fields only. lines are its push
// notification's body (when and where, on one line); details are the date,
// time and place, each on a line of its own in the Telegram message, with
// the cover picture (image, a JPEG address, or null) under the link.
export function noticeFor(kind, row) {
  const url = `${siteUrl()}/e/${row.slug}`;
  const lines = [whenText(row), placeText(row)].filter(Boolean);
  const details = [['Date', startDateText(row)]];
  const time = startTimeText(row);
  if (time) {
    details.push(['Time', time]);
  }
  details.push(['Location', placeText(row) || 'To be announced']);
  const notice = { title: row.title, lines, intro: '', details, url, image: embedImageUrl(row) };
  if (kind === 'cancelled') {
    const message = 'This event will not go ahead.';
    return { ...notice, heading: 'Event cancelled', lines: [message], intro: message, tag: `event-${row.slug}` };
  }
  if (kind === 'updated') {
    const message = 'The time or place changed. Now:';
    return { ...notice, heading: 'Event updated', lines: [message, ...lines], intro: message, tag: `event-${row.slug}` };
  }
  if (kind === 'timetable') {
    const message = 'The timetable changed. See the event page for the latest.';
    return { ...notice, heading: 'Timetable updated', lines: [message], intro: message, tag: `event-${row.slug}` };
  }
  if (kind === 'paid') {
    const message = 'Your payment is confirmed. See you there.';
    return { ...notice, heading: 'Payment confirmed', lines: [message], intro: message, tag: `paid-${row.slug}` };
  }
  return { ...notice, heading: 'New event', tag: `new-${row.slug}` };
}

// Tells one person an editor confirmed their payment (migrations/016), by
// push and, when they asked for notices on Telegram, there. Sent whatever
// their notice choices, as they are waiting for it; an account that is not
// active hears nothing. row: the event, with what noticeFor reads.
export async function sendPaymentConfirmed(row, accountId) {
  const { data, error } = await database()
    .from(TABLES.accounts)
    .select('id, status, notify_telegram')
    .eq('id', accountId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data || data.status !== 'active') {
    return 0;
  }
  return deliver([data], noticeFor('paid', row));
}

// The linked Telegram chat of each account that has one, as a Map of
// account id to chat id. Empty when Telegram is not set up.
async function telegramChats(accountIds) {
  if (!telegramConfigured() || accountIds.length === 0) {
    return new Map();
  }
  const { data, error } = await database().from(TABLES.telegram).select('user_id, chat_id').in('user_id', accountIds);
  if (error) {
    throw error;
  }
  return new Map(rowsOf(data).map((link) => [link.user_id, link.chat_id]));
}

// accounts: [{ id, notify_telegram }]. Returns how many accounts were reached.
// Each account gets the notice by push, and by Telegram when it asked for
// that and has a linked chat; it counts as reached when either got through.
// CONCURRENCY workers share one queue, so a slow account holds up only one.
export async function deliver(accounts, notice) {
  const telegramAccountIds = accounts.filter((account) => account.notify_telegram).map((account) => account.id);
  const chats = await telegramChats(telegramAccountIds);
  const payload = { title: `${notice.heading}: ${notice.title}`, body: notice.lines.join(' · '), url: notice.url, tag: notice.tag };
  let reached = 0;
  const queue = [...accounts];
  async function worker() {
    while (queue.length) {
      const account = queue.shift();
      let reachedAccount = (await pushToAccount(account.id, payload)) > 0;
      const chat = chats.get(account.id);
      if (chat) {
        // A reminder brings its own, fuller message (reminderNotice).
        let message = notice.rich;
        if (!message) {
          message = eventNoticeMessage(notice);
        }
        try {
          await sendRichTelegram(chat, message);
          reachedAccount = true;
        } catch (cause) {
          console.warn('[helloevents] telegram notice:', errorDetail(cause));
        }
      }
      if (reachedAccount) {
        reached += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return reached;
}

// An account that is active and has this kind of notice switched on.
// preference: the column, such as "notify_updates".
function wantsNotice(account, preference) {
  if (account && account.status === 'active' && account[preference] === true) {
    return true;
  }
  return false;
}

// The accounts going to an event that want this kind of notice.
async function attendeeAccounts(eventId, preference) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`user_id, account:${TABLES.accounts} ( id, status, notify_updates, notify_reminders, notify_telegram )`)
    .eq('event_id', eventId);
  if (error) {
    throw error;
  }
  return rowsOf(data)
    .map((row) => row.account)
    .filter((account) => wantsNotice(account, preference));
}

// Whether one field differs between two versions of an event. A missing
// field counts as null (and a missing "time to be confirmed" flag as
// false), and two timestamps are compared as moments, so the same time
// written two ways is not a change.
function fieldChanged(field, before, after) {
  if (field.endsWith('_tbc')) {
    return (before[field] === true) !== (after[field] === true);
  }
  let oldValue = before[field];
  if (oldValue === undefined) {
    oldValue = null;
  }
  let newValue = after[field];
  if (newValue === undefined) {
    newValue = null;
  }
  if (field.endsWith('_at') && oldValue && newValue) {
    return new Date(oldValue).getTime() !== new Date(newValue).getTime();
  }
  return oldValue !== newValue;
}

// Whether the places changed, compared in one shape, so an event saved
// before the locations list (its place only in the venue columns, or
// copied into the list by migrations/004) is not "moved" by its next save.
function locationsChanged(before, after) {
  return JSON.stringify(storedLocations(before)) !== JSON.stringify(storedLocations(after));
}

// Whether a meal's own places changed (one moved, or a meal now held
// somewhere other than the event, or back at it). A meal added, removed or
// with a new limit is not a move. A notice_base kept before meal places
// existed has no meal_options, and is taken as unchanged.
function mealPlacesChanged(before, after) {
  if (!('meal_options' in before) || !('meal_options' in after)) {
    return false;
  }
  const placesOf = (row) => {
    const places = {};
    for (const meal of storedMeals(row)) {
      places[meal.id] = meal.locations;
    }
    return places;
  };
  const old = placesOf(before);
  const now = placesOf(after);
  return Object.keys(now).some((id) => {
    if (!(id in old)) {
      return false;
    }
    return JSON.stringify(old[id]) !== JSON.stringify(now[id]);
  });
}

// The timetable as the event page shows it, in one comparable shape: each
// item's title, day, start and note, and unless timeOnly, its end and room
// (by its name and tag, so renaming a room is a change but its id is not).
// A timeline shows no ends or rooms, so for one (before or after) those are
// left out: changing them, or switching between a timeline and a grid, is
// not news.
function timetableShape(row, timeOnly) {
  const timetable = storedTimetable(row);
  const rooms = new Map(timetable.rooms.map((room) => [room.id, [room.name, room.tag]]));
  return JSON.stringify(timetable.items.map((item) => {
    if (timeOnly) {
      return [item.title, item.date, item.start, item.note];
    }
    let room = null;
    if (item.room !== null) {
      room = rooms.get(item.room);
    }
    return [item.title, item.date, item.start, item.end, room, item.note];
  }));
}

// Whether the timetable people can see changed (migrations/014): an item
// added, removed, moved or renamed, or its room renamed. A notice_base kept
// before timetables existed has no timetable_items, and is taken as
// unchanged.
function timetableChanged(before, after) {
  if (!('timetable_items' in before) || !('timetable_items' in after)) {
    return false;
  }
  let timeOnly = false;
  if (storedTimetable(before).view === 'timeline' || storedTimetable(after).view === 'timeline') {
    timeOnly = true;
  }
  return timetableShape(before, timeOnly) !== timetableShape(after, timeOnly);
}

// What changed between two versions of an event that people going should
// hear about: "cancelled", "updated" (when or where), "timetable" (only the
// timetable, while the page shows it) or null.
export function changeKind(before, after) {
  if (!isReleased(after)) {
    return null;
  }
  if (after.status === 'cancelled' && before.status !== 'cancelled') {
    return 'cancelled';
  }
  if (after.status === 'cancelled') {
    return null;
  }
  const fields = [
    'starts_at', 'ends_at', 'start_time_tbc', 'end_time_tbc', 'timezone', 'dates_hidden',
    'venue_name', 'venue_address', 'city', 'country', 'is_online',
  ];
  let moved = fields.some((field) => fieldChanged(field, before, after));
  if (locationsChanged(before, after) || mealPlacesChanged(before, after)) {
    moved = true;
  }
  if (moved && isReleased(before)) {
    return 'updated';
  }
  if (isReleased(before) && datesAnnounced(after) && timetableChanged(before, after)) {
    return 'timetable';
  }
  return null;
}

// The edit form on /manage saves each field as the editor leaves it, so one
// change of when or where (a new date, then a new start time) can come as
// several saves. People going hear about it once. The first save that moves
// a released event keeps how the event was (notice_base, migrations/006),
// and every save while one is waiting sets notice_due_at changeNotice.waitMs
// ahead. When that passes with no newer save, flushEventChange compares
// notice_base with the event as it is then, so a change that is put back
// tells nobody. The wait fits inside api/manage/events.js's maxDuration
// (vercel.json); the notification cron sends any that were left over. Tests
// shorten it.
export const changeNotice = { waitMs: 45_000, graceMs: 1_000 };

// The columns changeKind reads, as kept in notice_base.
const NOTICE_BASE_COLUMNS = [
  'status', 'publish_at', 'starts_at', 'ends_at', 'start_time_tbc', 'end_time_tbc', 'timezone', 'dates_hidden',
  'venue_name', 'venue_address', 'city', 'country', 'is_online', 'locations', 'meal_options',
  'timetable_view', 'timetable_rooms', 'timetable_items',
];

// What flushEventChange reads: the columns above, and what a notice says.
const NOTICE_ROW_COLUMNS = `id, slug, title, cover_image_path, ${NOTICE_BASE_COLUMNS.join(', ')}, notice_base, notice_due_at`;

function noticeBase(row) {
  const base = {};
  for (const column of NOTICE_BASE_COLUMNS) {
    let value = row[column];
    if (value === undefined) {
      value = null;
    }
    base[column] = value;
  }
  return base;
}

// Before an editor's save: the notice columns to save with it. changes are
// the columns about to be written over before (which carries notice_base).
// Empty when there is nothing for the people going to hear about.
export function queueEventChange(before, changes, now = Date.now()) {
  let base = before.notice_base;
  if (!base) {
    if (!changeKind(before, { ...before, ...changes })) {
      return {};
    }
    base = noticeBase(before);
  }
  return { notice_base: base, notice_due_at: new Date(now + changeNotice.waitMs).toISOString() };
}

// After a save that queued a notice, in the background: waits until it is
// due, then sends it (or leaves it to a newer save's wait).
export async function sendEventChangeWhenDue(eventId) {
  await new Promise((resolve) => {
    setTimeout(resolve, changeNotice.waitMs + changeNotice.graceMs);
  });
  return flushEventChange(eventId);
}

// Tells the people going about an event's queued change, once it is due.
// It is claimed first, by clearing both columns only while notice_due_at is
// still the one read, so a newer save's wait, or two runs at once, never
// send it twice. Returns how many accounts were reached.
export async function flushEventChange(eventId, now = Date.now()) {
  const { data: row, error } = await database().from(TABLES.events).select(NOTICE_ROW_COLUMNS).eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!row || !row.notice_base || !row.notice_due_at) {
    return 0;
  }
  if (new Date(row.notice_due_at).getTime() > now) {
    return 0;
  }
  const { data: claimed, error: claimError } = await database()
    .from(TABLES.events)
    .update({ notice_base: null, notice_due_at: null })
    .eq('id', eventId)
    .eq('notice_due_at', row.notice_due_at)
    .select('id');
  if (claimError) {
    throw claimError;
  }
  if (rowsOf(claimed).length !== 1) {
    return 0;
  }
  const kind = changeKind(row.notice_base, row);
  if (!kind) {
    return 0;
  }
  const accounts = await attendeeAccounts(eventId, 'notify_updates');
  return deliver(accounts, noticeFor(kind, row));
}

// Hourly (cron/notify.js): queued changes whose background send never ran,
// say because the function was stopped first.
export async function flushDueChanges(now = Date.now()) {
  const { data, error } = await database()
    .from(TABLES.events)
    .select('id')
    .lte('notice_due_at', new Date(now).toISOString())
    .limit(100);
  if (error) {
    throw error;
  }
  let reached = 0;
  for (const row of rowsOf(data)) {
    reached += await flushEventChange(row.id, now);
  }
  return reached;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

// Which reminder is due for one RSVP, if any: { hours, send, mark }, or null
// when nothing is to be done.
//
//   chosen  the account's reminder times (hours before the start)
//   sent    the times already dealt with for this RSVP (reminders_sent)
//   rsvpAt  when they said they were going
//
// A time is passed once the start is that close (REMINDER_LEAD_MS early).
// Only the closest time passed goes out, so a cron that was down, or a week
// and a day both passed, never sends two at once; the ones it overtook are
// marked with it (mark: every time passed, to save as reminders_sent). A time
// that came before someone said they were going is marked but not sent: they
// have just seen the event. An event whose start time is to be confirmed
// gets the day and week reminders only.
export function dueReminder({ startsAt, timeTbc = false, chosen, sent, rsvpAt = null, now = Date.now() }) {
  const start = Date.parse(startsAt);
  if (!(start > now)) {
    return null;
  }
  let hours = reminderHoursFrom(chosen);
  if (timeTbc) {
    hours = hours.filter((each) => each >= 24);
  }
  const done = reminderHoursFrom(sent);
  const passed = hours.filter((each) => now + REMINDER_LEAD_MS >= start - each * 3_600_000);
  if (!passed.some((each) => !done.includes(each))) {
    return null;
  }
  const closest = Math.min(...passed);
  let send = !done.includes(closest);
  if (send && rsvpAt && Date.parse(rsvpAt) > start - closest * 3_600_000) {
    send = false;
  }
  return { hours: closest, send, mark: reminderHoursFrom([...done, ...passed]) };
}

// A meal by name: the editor's, or breakfast, lunch or dinner.
function mealName(meal) {
  if (meal.label) {
    return meal.label;
  }
  return meal.id.charAt(0).toUpperCase() + meal.id.slice(1);
}

// What a place is: "Event location", "Meeting location" or the editor's
// own label; for one of a meal's places, the meal's name, with the label
// when it is not where the meal itself is ("Dinner · Meeting location").
function placeHeading(location, meal = null) {
  let label = 'Event location';
  if (location.label === 'meeting') {
    label = 'Meeting location';
  } else if (location.label === 'custom' && location.custom_label) {
    label = location.custom_label;
  }
  if (!meal) {
    return label;
  }
  if (location.label === 'meal') {
    return mealName(meal);
  }
  return `${mealName(meal)} · ${label}`;
}

// A place's details, as [label, value] rows, blanks left out.
function placeRows(location) {
  const rows = [
    ['Venue', location.venue_name],
    ['Address', location.venue_address],
    ['City', location.city],
    ['Country', countryText(location.country)],
    ['Map', location.maps_url],
  ].filter(([, value]) => value);
  if (rows.length === 0) {
    return [['Place', 'To be announced']];
  }
  return rows;
}

// The reminder for someone going to an event (row: the event, with its
// locations and meals), coming for the whole event (chosen empty) or just
// for those meals. It is a notice (heading, title, lines, url, tag) whose
// push notification says only when and where, plus details, places and meal
// places for its Telegram message (rich, reminderMessage): when it starts
// and ends, what they are coming for, the online link, every place of the
// event with its address and map link, and each meal held somewhere else
// (just their meals, when they are coming only for those).
export function reminderNotice(row, chosen = [], now = Date.now()) {
  const url = `${siteUrl()}/e/${row.slug}`;
  const meals = storedMeals(row);
  let picked = [];
  if (Array.isArray(chosen)) {
    picked = meals.filter((meal) => chosen.includes(meal.id));
  }
  const details = [['When', whenText(row)]];
  const ends = endText(row);
  if (ends) {
    details.push(['Ends', ends]);
  }
  if (picked.length) {
    details.push(['Coming for', `${picked.map(mealName).join(', ')} only`]);
  } else if (meals.length) {
    details.push(['Coming for', 'The whole event']);
  }
  if (row.is_online && row.online_url) {
    details.push(['Online link', row.online_url]);
  }
  const places = storedLocations(row).map((location) => ({ heading: placeHeading(location), rows: placeRows(location) }));
  let mealsShown = meals;
  let mealsHeading = 'Meals held elsewhere';
  if (picked.length) {
    mealsShown = picked;
    mealsHeading = 'Your meals';
  }
  const mealPlaces = mealsShown.flatMap((meal) => meal.locations.map((location) => ({
    heading: placeHeading(location, meal),
    rows: placeRows(location),
  })));
  const notice = {
    heading: `Starting in ${untilText(Date.parse(row.starts_at) - now)}`,
    title: row.title,
    lines: [whenText(row), placeText(row)].filter(Boolean),
    url,
    tag: `reminder-${row.slug}`,
    details,
    places,
    online: false,
    mealsHeading,
    mealPlaces,
  };
  if (row.is_online === true && places.length === 0) {
    notice.online = true;
  }
  notice.rich = reminderMessage(notice);
  return notice;
}

// What sendReminders reads of an event: the reminder's when and where.
const REMINDER_EVENT_COLUMNS =
  'id, slug, title, status, publish_at, starts_at, ends_at, start_time_tbc, end_time_tbc, timezone, dates_hidden, ' +
  'venue_name, venue_address, city, country, is_online, online_url, locations, meal_options';

// Every ten minutes: for each RSVP to an event starting within the week, the
// reminder due at the times its account picked (dueReminder). Each RSVP's
// times are marked as dealt with before anything is sent, so a slow or
// failing send is never repeated in the next run. Returns how many accounts
// were reached.
export async function sendReminders(now = Date.now()) {
  const windowStart = new Date(now).toISOString();
  const windowEnd = new Date(now + REMIND_WITHIN_HOURS * 3_600_000 + REMINDER_LEAD_MS).toISOString();
  const { data: events, error } = await database()
    .from(TABLES.events)
    .select(REMINDER_EVENT_COLUMNS)
    .eq('status', 'published')
    .eq('dates_hidden', false)
    .gt('starts_at', windowStart)
    .lte('starts_at', windowEnd)
    .limit(500);
  if (error) {
    throw error;
  }
  let sent = 0;
  const releasedEvents = rowsOf(events).filter((candidate) => isReleased(candidate, now));
  for (const event of releasedEvents) {
    const { data: rows, error: rowsError } = await database()
      .from(TABLES.attendees)
      .select(`user_id, created_at, meals, reminders_sent, account:${TABLES.accounts} ( id, status, reminder_hours, notify_telegram )`)
      .eq('event_id', event.id);
    if (rowsError) {
      throw rowsError;
    }
    // The accounts to remind now, by the meals they are coming for (each
    // group gets one notice).
    const groups = new Map();
    for (const row of rowsOf(rows)) {
      const account = row.account;
      if (!account || account.status !== 'active') {
        continue;
      }
      const due = dueReminder({
        startsAt: event.starts_at,
        timeTbc: event.start_time_tbc === true,
        chosen: account.reminder_hours,
        sent: row.reminders_sent,
        rsvpAt: row.created_at,
        now,
      });
      if (!due) {
        continue;
      }
      const { error: markError } = await database()
        .from(TABLES.attendees)
        .update({ reminders_sent: due.mark })
        .eq('event_id', event.id)
        .eq('user_id', row.user_id);
      if (markError) {
        throw markError;
      }
      if (!due.send) {
        continue;
      }
      let meals = [];
      if (Array.isArray(row.meals)) {
        meals = row.meals;
      }
      const key = JSON.stringify(meals);
      if (!groups.has(key)) {
        groups.set(key, { meals, accounts: [] });
      }
      groups.get(key).accounts.push(account);
    }
    for (const group of groups.values()) {
      sent += await deliver(group.accounts, reminderNotice(event, group.meals, now));
    }
  }
  return sent;
}

// Each cron run: one "new event" notice per newly released event, to the accounts
// that asked for them. Each event is marked as announced before its notice
// goes out, and one that is already over is marked without a notice.
export async function announceNewEvents(now = Date.now()) {
  const { data: events, error } = await database()
    .from(TABLES.events)
    .select('id, slug, title, cover_image_path, status, publish_at, starts_at, ends_at, start_time_tbc, timezone, dates_hidden, venue_name, city, is_online, last_at')
    .eq('status', 'published')
    .is('announced_at', null)
    .limit(20);
  if (error) {
    throw error;
  }
  const released = rowsOf(events).filter((candidate) => isReleased(candidate, now));
  const isPast = (event) => {
    if (event.last_at && new Date(event.last_at).getTime() < now) {
      return true;
    }
    return false;
  };
  // Released but already over: nothing to announce, but marked so it does
  // not sit in the next run's window forever.
  for (const event of released.filter(isPast)) {
    const { error: markError } = await database().from(TABLES.events).update({ announced_at: new Date(now).toISOString() }).eq('id', event.id);
    if (markError) {
      throw markError;
    }
  }
  const fresh = released.filter((event) => !isPast(event));
  if (fresh.length === 0) {
    return 0;
  }
  const { data: accounts, error: accountsError } = await database()
    .from(TABLES.accounts)
    .select('id, status, notify_telegram')
    .eq('notify_new_events', true)
    .eq('status', 'active')
    .limit(MAX_ANNOUNCE);
  if (accountsError) {
    throw accountsError;
  }
  const recipients = rowsOf(accounts);
  let sent = 0;
  for (const event of fresh) {
    const { error: markError } = await database().from(TABLES.events).update({ announced_at: new Date(now).toISOString() }).eq('id', event.id).is('announced_at', null);
    if (markError) {
      throw markError;
    }
    sent += await deliver(recipients, noticeFor('new', event));
  }
  return sent;
}
