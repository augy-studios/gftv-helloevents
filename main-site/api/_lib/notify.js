// Notifications about events, kept modest. Three kinds, each one a choice on
// the account page (gftvevents_accounts.notify_*):
//
//   updates    an event you are going to changes when or where it happens,
//              or is cancelled (sent when an editor saves the change)
//   reminders  a day before an event you are going to (cron/notify.js,
//              hourly; once per RSVP)
//   newEvents  a new event is announced, off by default (cron/notify.js,
//              once per event, when it is released)
//
// Each goes to the account's browsers by Web Push (push.js) and, when the
// account switched "also send to Telegram" on and has a linked chat, to the
// Telegram bot as a rich message.
//
// Only released events are ever announced, and a notice carries only what
// the public event page shows: title, when (unless to be announced), the
// place name and the page link. Never an online link or an attendees-only
// address; those stay on the event page for people going.

import { waitUntil } from '@vercel/functions';
import { database, TABLES } from './supabase.js';
import { siteUrl } from './env.js';
import { pushToAccount } from './push.js';
import { sendRichTelegram, telegramConfigured } from './telegram.js';
import { eventNoticeMessage } from './telegram-messages.js';
import { isReleased, datesAnnounced } from './event-rules.js';

const CONCURRENCY = 8;
// The most accounts one "new event" run tells, so one cron run stays short.
export const MAX_ANNOUNCE = 2000;
export const REMIND_WITHIN_HOURS = 24;

// What to log for a failure: its message, or the thrown value itself when
// it has none.
function describeCause(cause) {
  if (cause === null || cause === undefined) {
    return cause;
  }
  const message = cause.message;
  if (message === null || message === undefined) {
    return cause;
  }
  return message;
}

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
  const tracked = Promise.resolve(promise).catch((cause) => console.error('[helloevents] notify:', describeCause(cause)));
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

// When the event starts, in its own time zone, or "Dates to be announced".
function whenText(row) {
  if (!datesAnnounced(row)) {
    return 'Dates to be announced';
  }
  try {
    return new Intl.DateTimeFormat('en-SG', {
      timeZone: row.timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(row.starts_at));
  } catch {
    return new Date(row.starts_at).toUTCString();
  }
}

// The place name and city, and "online" for an online event.
function placeText(row) {
  const parts = [row.venue_name, row.city].filter(Boolean);
  if (row.is_online) {
    parts.push('online');
  }
  return parts.join(', ');
}

// The notice for one event, from public fields only.
export function noticeFor(kind, row) {
  const url = `${siteUrl()}/e/${row.slug}`;
  const lines = [whenText(row), placeText(row)].filter(Boolean);
  if (kind === 'cancelled') {
    return { heading: 'Event cancelled', title: row.title, lines: ['This event will not go ahead.'], url, tag: `event-${row.slug}` };
  }
  if (kind === 'updated') {
    return { heading: 'Event updated', title: row.title, lines: ['The time or place changed. Now:', ...lines], url, tag: `event-${row.slug}` };
  }
  if (kind === 'reminder') {
    return { heading: 'Tomorrow', title: row.title, lines, url, tag: `reminder-${row.slug}` };
  }
  return { heading: 'New event', title: row.title, lines, url, tag: `new-${row.slug}` };
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
        const message = eventNoticeMessage(notice);
        try {
          await sendRichTelegram(chat, message);
          reachedAccount = true;
        } catch (cause) {
          console.warn('[helloevents] telegram notice:', describeCause(cause));
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
// field counts as null, and two timestamps are compared as moments, so the
// same time written two ways is not a change.
function fieldChanged(field, before, after) {
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

// What changed between two versions of an event that people going should
// hear about: "cancelled", "updated" or null.
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
  const fields = ['starts_at', 'ends_at', 'timezone', 'dates_hidden', 'venue_name', 'venue_address', 'city', 'country', 'is_online'];
  const moved = fields.some((field) => fieldChanged(field, before, after));
  if (moved && isReleased(before)) {
    return 'updated';
  }
  return null;
}

// After an editor saves an event. Runs in the background.
export async function notifyEventChange(before, after) {
  const kind = changeKind(before, after);
  if (!kind) {
    return 0;
  }
  const accounts = await attendeeAccounts(after.id, 'notify_updates');
  return deliver(accounts, noticeFor(kind, after));
}

// Hourly: reminders for events starting within the next day, once per RSVP.
// Each RSVP is marked as reminded before anything is sent, so a slow or
// failing send is never repeated in the next hour's run.
export async function sendReminders(now = Date.now()) {
  const windowStart = new Date(now).toISOString();
  const windowEnd = new Date(now + REMIND_WITHIN_HOURS * 3600_000).toISOString();
  const { data: events, error } = await database()
    .from(TABLES.events)
    .select('id, slug, title, status, publish_at, starts_at, ends_at, timezone, dates_hidden, venue_name, city, is_online')
    .eq('status', 'published')
    .eq('dates_hidden', false)
    .gte('starts_at', windowStart)
    .lte('starts_at', windowEnd)
    .limit(200);
  if (error) {
    throw error;
  }
  let sent = 0;
  const releasedEvents = rowsOf(events).filter((candidate) => isReleased(candidate, now));
  for (const event of releasedEvents) {
    const { data: rows, error: rowsError } = await database()
      .from(TABLES.attendees)
      .select(`user_id, account:${TABLES.accounts} ( id, status, notify_reminders, notify_telegram )`)
      .eq('event_id', event.id)
      .is('reminded_at', null);
    if (rowsError) {
      throw rowsError;
    }
    const due = rowsOf(rows)
      .map((row) => row.account)
      .filter(Boolean);
    if (due.length === 0) {
      continue;
    }
    // Marked first, so a slow or failing send is never repeated next hour.
    const { error: markError } = await database()
      .from(TABLES.attendees)
      .update({ reminded_at: new Date(now).toISOString() })
      .eq('event_id', event.id)
      .is('reminded_at', null);
    if (markError) {
      throw markError;
    }
    const wanted = due.filter((account) => wantsNotice(account, 'notify_reminders'));
    sent += await deliver(wanted, noticeFor('reminder', event));
  }
  return sent;
}

// Hourly: one "new event" notice per newly released event, to the accounts
// that asked for them. Each event is marked as announced before its notice
// goes out, and one that is already over is marked without a notice.
export async function announceNewEvents(now = Date.now()) {
  const { data: events, error } = await database()
    .from(TABLES.events)
    .select('id, slug, title, status, publish_at, starts_at, ends_at, timezone, dates_hidden, venue_name, city, is_online, last_at')
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
