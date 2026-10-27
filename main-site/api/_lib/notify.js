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
import { db, T } from './supabase.js';
import { siteUrl } from './env.js';
import { pushToAccount } from './push.js';
import { sendRichTelegram, telegramConfigured } from './telegram.js';
import { eventNoticeMessage } from './telegram-messages.js';
import { isReleased, datesAnnounced } from './event-rules.js';

const CONCURRENCY = 8;
// The most accounts one "new event" run tells, so one cron run stays short.
export const MAX_ANNOUNCE = 2000;
export const REMIND_WITHIN_HOURS = 24;

// Background work after a response, kept alive on Vercel with waitUntil.
// Tests await settle() to see it finish.
const pending = new Set();
export function background(promise) {
  const p = Promise.resolve(promise).catch((cause) => console.error('[helloevents] notify:', cause?.message ?? cause));
  pending.add(p);
  p.finally(() => pending.delete(p));
  try {
    waitUntil(p);
  } catch {
    /* not on Vercel */
  }
  return p;
}
export async function settle() {
  while (pending.size) await Promise.all([...pending]);
}

function when(row) {
  if (!datesAnnounced(row)) return 'Dates to be announced';
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

function place(row) {
  const parts = [row.venue_name, row.city].filter(Boolean);
  if (row.is_online) parts.push('online');
  return parts.join(', ');
}

// The notice for one event, from public fields only.
export function noticeFor(kind, row) {
  const url = `${siteUrl()}/e/${row.slug}`;
  const lines = [when(row), place(row)].filter(Boolean);
  if (kind === 'cancelled') return { heading: 'Event cancelled', title: row.title, lines: ['This event will not go ahead.'], url, tag: `event-${row.slug}` };
  if (kind === 'updated') return { heading: 'Event updated', title: row.title, lines: ['The time or place changed. Now:', ...lines], url, tag: `event-${row.slug}` };
  if (kind === 'reminder') return { heading: 'Tomorrow', title: row.title, lines, url, tag: `reminder-${row.slug}` };
  return { heading: 'New event', title: row.title, lines, url, tag: `new-${row.slug}` };
}

async function telegramChats(accountIds) {
  if (!telegramConfigured() || accountIds.length === 0) return new Map();
  const { data, error } = await db().from(T.telegram).select('user_id, chat_id').in('user_id', accountIds);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.user_id, r.chat_id]));
}

// accounts: [{ id, notify_telegram }]. Returns how many accounts were reached.
export async function deliver(accounts, notice) {
  const chats = await telegramChats(accounts.filter((a) => a.notify_telegram).map((a) => a.id));
  const payload = { title: `${notice.heading}: ${notice.title}`, body: notice.lines.join(' · '), url: notice.url, tag: notice.tag };
  let reached = 0;
  const queue = [...accounts];
  async function worker() {
    while (queue.length) {
      const account = queue.shift();
      let got = (await pushToAccount(account.id, payload)) > 0;
      const chat = chats.get(account.id);
      if (chat) {
        await sendRichTelegram(chat, eventNoticeMessage(notice)).then(() => { got = true; }, (cause) => console.warn('[helloevents] telegram notice:', cause?.message ?? cause));
      }
      if (got) reached += 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return reached;
}

async function attendeeAccounts(eventId, pref) {
  const { data, error } = await db()
    .from(T.attendees)
    .select(`user_id, account:${T.accounts} ( id, status, notify_updates, notify_reminders, notify_telegram )`)
    .eq('event_id', eventId);
  if (error) throw error;
  return (data ?? []).map((r) => r.account).filter((a) => a && a.status === 'active' && a[pref] === true);
}

// What changed between two versions of an event that people going should
// hear about: "cancelled", "updated" or null.
export function changeKind(before, after) {
  if (!isReleased(after)) return null;
  if (after.status === 'cancelled' && before.status !== 'cancelled') return 'cancelled';
  if (after.status === 'cancelled') return null;
  const fields = ['starts_at', 'ends_at', 'timezone', 'dates_hidden', 'venue_name', 'venue_address', 'city', 'country', 'is_online'];
  const moved = fields.some((f) => {
    const a = before[f] ?? null;
    const b = after[f] ?? null;
    return f.endsWith('_at') && a && b ? new Date(a).getTime() !== new Date(b).getTime() : a !== b;
  });
  return moved && isReleased(before) ? 'updated' : null;
}

// After an editor saves an event. Runs in the background.
export async function notifyEventChange(before, after) {
  const kind = changeKind(before, after);
  if (!kind) return 0;
  const accounts = await attendeeAccounts(after.id, 'notify_updates');
  return deliver(accounts, noticeFor(kind, after));
}

// Hourly: reminders for events starting within the next day, once per RSVP.
export async function sendReminders(now = Date.now()) {
  const from = new Date(now).toISOString();
  const to = new Date(now + REMIND_WITHIN_HOURS * 3600_000).toISOString();
  const { data: events, error } = await db()
    .from(T.events)
    .select('id, slug, title, status, publish_at, starts_at, ends_at, timezone, dates_hidden, venue_name, city, is_online')
    .eq('status', 'published')
    .eq('dates_hidden', false)
    .gte('starts_at', from)
    .lte('starts_at', to)
    .limit(200);
  if (error) throw error;
  let sent = 0;
  for (const event of (events ?? []).filter((e) => isReleased(e, now))) {
    const { data: rows, error: rowsError } = await db()
      .from(T.attendees)
      .select(`user_id, account:${T.accounts} ( id, status, notify_reminders, notify_telegram )`)
      .eq('event_id', event.id)
      .is('reminded_at', null);
    if (rowsError) throw rowsError;
    const due = (rows ?? []).map((r) => r.account).filter(Boolean);
    if (due.length === 0) continue;
    // Marked first, so a slow or failing send is never repeated next hour.
    const { error: markError } = await db()
      .from(T.attendees)
      .update({ reminded_at: new Date(now).toISOString() })
      .eq('event_id', event.id)
      .is('reminded_at', null);
    if (markError) throw markError;
    const wanted = due.filter((a) => a.status === 'active' && a.notify_reminders === true);
    sent += await deliver(wanted, noticeFor('reminder', event));
  }
  return sent;
}

// Hourly: one "new event" notice per newly released event, to the accounts
// that asked for them.
export async function announceNewEvents(now = Date.now()) {
  const { data: events, error } = await db()
    .from(T.events)
    .select('id, slug, title, status, publish_at, starts_at, ends_at, timezone, dates_hidden, venue_name, city, is_online, last_at')
    .eq('status', 'published')
    .is('announced_at', null)
    .limit(20);
  if (error) throw error;
  const released = (events ?? []).filter((e) => isReleased(e, now));
  const isPast = (e) => Boolean(e.last_at && new Date(e.last_at).getTime() < now);
  // Released but already over: nothing to announce, but marked so it does
  // not sit in the next run's window forever.
  for (const event of released.filter(isPast)) {
    const { error: markError } = await db().from(T.events).update({ announced_at: new Date(now).toISOString() }).eq('id', event.id);
    if (markError) throw markError;
  }
  const fresh = released.filter((e) => !isPast(e));
  if (fresh.length === 0) return 0;
  const { data: accounts, error: accountsError } = await db()
    .from(T.accounts)
    .select('id, status, notify_telegram')
    .eq('notify_new_events', true)
    .eq('status', 'active')
    .limit(MAX_ANNOUNCE);
  if (accountsError) throw accountsError;
  let sent = 0;
  for (const event of fresh) {
    const { error: markError } = await db().from(T.events).update({ announced_at: new Date(now).toISOString() }).eq('id', event.id).is('announced_at', null);
    if (markError) throw markError;
    sent += await deliver(accounts ?? [], noticeFor('new', event));
  }
  return sent;
}
