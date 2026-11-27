// Telegram alerts for the people running events (migrations/026): the
// admins' chats and each event's organisers' chats.
//
//   Admins (ADMIN_CHAT_IDS, any number of chat ids, a person's or a group's,
//   separated by commas or spaces) hear about:
//     - each new attendee, as they join (alertNewAttendee)
//     - a payment reported, to be checked (alertPaymentReported)
//     - a payment confirmed (alertPaymentConfirmed)
//     - each new event, once it is published: sent once the editor stops
//       saving, the same wait as change notices (notify.js changeNotice), or
//       at its release time when that is later (queueAdminEventNotice)
//     - each passed ID check, as "otter has HelloID" (admin-chats.js
//       alertIdVerified, from id-checks.js and helloid-checks.js)
//   Organisers (organiser_chat_ids on the event, set by an admin on the edit
//   form's Organisers tab) hear about:
//     - each new attendee, once they have given everything the event asks
//       for (contact details by its rule, the registration form's answers):
//       as they join, or later when they finish (alertAttendeeCompleted);
//       once per attendee (organisers_told_at)
//     - a payment confirmed
//
// The messages carry what the attendee list shows the event's editors: the
// person's name and username, their RSVP ID, what they are coming for, their
// ticket and payment, and the contact details the event asks for. Never an
// email, the registration form's answers or a payment screenshot.
//
// A chat that cannot be reached (the bot is not in the group, or the person
// never pressed Start) is logged and skipped; it never stops the others.

import { database, TABLES } from './supabase.js';
import { siteUrl } from './env.js';
import { parseChatIds, adminChatIds, sendToChats } from './admin-chats.js';
import { attendeeView } from './serialize.js';
import { PAYMENT_COLUMNS } from './events.js';
import { isReleased, storedMeals, heldRegistrationFields } from './event-rules.js';
import { whenText, placeText } from './event-text.js';
import { staffAlertMessage } from './telegram-messages.js';
import { changeNotice } from './notify.js';
import { storedContactFields, storedContactRule, storedContact, contactComplete, contactText } from '../../js/contact-fields.js';
import { storedAnswers, answersComplete } from '../../js/registration-fields.js';

// The chat helpers live in admin-chats.js (the ID check modules use them
// too); re-exported for the routes and tests that import them from here.
export { parseChatIds, adminChatIds, sendToChats };

// The most chats one event may name.
export const MAX_ORGANISER_CHATS = 10;

const METHOD_NAMES = { onsite: 'Pay on the day', link: 'Payment link', qr: 'QR code' };
const STATUS_NAMES = { awaiting: 'Waiting for payment', submitted: 'Reported, to be checked', paid: 'Paid' };
const KIND_NAMES = { furmeet: 'Furmeet', convention: 'Convention', other: 'Other' };
// The ready-made contact fields' names (their label is null), as en.json's
// contact.field.* has them.
const PRESET_NAMES = { phone: 'Phone number', telegram: 'Telegram username', discord: 'Discord username' };

// An event's organisers' chats, as stored.
export function organiserChatIds(row) {
  if (!row) {
    return [];
  }
  return parseChatIds(row.organiser_chat_ids).slice(0, MAX_ORGANISER_CHATS);
}

// One attendee's row, with their account, as the attendee list reads it.
async function attendeeRow(eventId, userId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(
      `user_id, rsvp_number, created_at, meals, lepak, volunteer, fursuiter, contact, registration, organisers_told_at, ${PAYMENT_COLUMNS}, ` +
        `account:${TABLES.accounts}!user_id ( kind, username, display_name, country, staff:${TABLES.users} ( username, display_name ) )`
    )
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// How many are going to the whole event (not just a meal, not lepak).
async function goingCount(eventId) {
  const { data, error } = await database().from(TABLES.attendees).select('meals, lepak').eq('event_id', eventId).limit(10000);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return 0;
  }
  const wholeEvent = (row) => {
    if (row.lepak === true) {
      return false;
    }
    if (Array.isArray(row.meals) && row.meals.length > 0) {
      return false;
    }
    return true;
  };
  return data.filter(wholeEvent).length;
}

// Whether someone going has given everything the event asks for: contact
// details by its rule, and every required answer of the registration form
// for the ticket they hold.
export function attendeeComplete(event, row) {
  const fields = storedContactFields(event);
  if (!contactComplete(fields, storedContactRule(event), storedContact(fields, row.contact))) {
    return false;
  }
  const questions = heldRegistrationFields(event, row);
  if (questions.length === 0) {
    return true;
  }
  return answersComplete(questions, storedAnswers(questions, row.registration));
}

function money(amount, currency) {
  if (amount === null || amount === undefined) {
    return '';
  }
  let prefix = '';
  if (currency) {
    prefix = `${currency} `;
  }
  return `${prefix}${Number(amount).toFixed(2)}`;
}

// What someone is coming for: the whole event, the event's lepak, or meals.
function comingFor(event, person) {
  if (person.lepak) {
    let label = 'Just Lepak Only';
    if (event.lepak_label) {
      label = event.lepak_label;
    }
    if (person.meals.length) {
      return `${label}, with ${mealNames(event, person.meals)}`;
    }
    return label;
  }
  if (person.meals.length) {
    return `${mealNames(event, person.meals)} only`;
  }
  return 'The whole event';
}

function mealNames(event, ids) {
  return storedMeals(event)
    .filter((meal) => ids.includes(meal.id))
    .map((meal) => {
      if (meal.label) {
        return meal.label;
      }
      return meal.id.charAt(0).toUpperCase() + meal.id.slice(1);
    })
    .join(', ');
}

// A name from a table of them, or the value itself when it has none.
function nameFrom(names, value) {
  if (names[value]) {
    return names[value];
  }
  return String(value);
}

// A ticket item: "Weekend pass", or "Weekend pass × 2".
function itemText(item) {
  if (item.quantity > 1) {
    return `${item.name} × ${item.quantity}`;
  }
  return item.name;
}

// The message about one attendee: heading ("New attendee", "Payment
// reported", "Payment confirmed"), then their details, ticket, payment and
// contact details, how many are going, and the event's page.
function attendeeMessage(heading, event, row, going) {
  const person = attendeeView(row, event);
  const details = [];
  let name = person.displayName;
  if (!name) {
    name = person.username;
  }
  details.push(['Name', name]);
  if (person.username) {
    details.push(['Username', person.username]);
  }
  if (person.staff) {
    details.push(['Account', 'Staff']);
  }
  if (person.rsvpNumber !== null) {
    details.push(['RSVP ID', `#${person.rsvpNumber}`]);
  }
  details.push(['Coming for', comingFor(event, person)]);
  const payment = person.payment;
  if (payment.items.length) {
    details.push(['Ticket', payment.items.map(itemText).join(', ')]);
  } else if (payment.tier) {
    details.push(['Ticket', payment.tier]);
  }
  if (payment.method) {
    details.push(['Payment', nameFrom(METHOD_NAMES, payment.method)]);
  }
  if (payment.status !== 'none') {
    details.push(['Status', STATUS_NAMES[payment.status]]);
  }
  const amount = money(payment.amount, payment.currency);
  if (amount && payment.status !== 'none') {
    details.push(['Amount', amount]);
  }
  if (payment.reference && payment.status !== 'none') {
    details.push(['Reference', payment.reference]);
  }
  let goingText = String(going);
  if (event.capacity) {
    goingText = `${going} of ${event.capacity}`;
  }
  details.push(['Going', goingText]);
  const contact = person.contact.map((each) => {
    let label = each.label;
    if (!label) {
      label = nameFrom(PRESET_NAMES, each.id);
    }
    return [label, contactText(each.type, each.value)];
  });
  return staffAlertMessage({ heading, title: event.title, details, contact, url: `${siteUrl()}/e/${event.slug}` });
}

// The organisers are told about this attendee once: the first caller to
// stamp organisers_told_at sends it.
async function claimOrganisers(eventId, userId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .update({ organisers_told_at: new Date().toISOString() })
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .is('organisers_told_at', null)
    .select('user_id');
  if (error) {
    throw error;
  }
  if (Array.isArray(data) && data.length === 1) {
    return true;
  }
  return false;
}

// Someone has just joined: the admins hear at once, the organisers too
// when their details are complete (otherwise when they finish them).
// event: the event's row, with its contact fields, form, meals and tiers.
export async function alertNewAttendee(event, userId) {
  const admins = adminChatIds();
  const organisers = organiserChatIds(event);
  if (admins.length === 0 && organisers.length === 0) {
    return;
  }
  const row = await attendeeRow(event.id, userId);
  if (!row) {
    return;
  }
  const message = attendeeMessage('New attendee', event, row, await goingCount(event.id));
  await sendToChats(admins, message);
  if (organisers.length && attendeeComplete(event, row) && (await claimOrganisers(event.id, userId))) {
    await sendToChats(organisers, message);
  }
}

// Someone going changed their contact details or answers: once they are
// complete, the organisers hear about them, if they have not yet.
export async function alertAttendeeCompleted(event, userId) {
  const organisers = organiserChatIds(event);
  if (organisers.length === 0) {
    return;
  }
  const row = await attendeeRow(event.id, userId);
  if (!row || row.organisers_told_at || !attendeeComplete(event, row)) {
    return;
  }
  if (await claimOrganisers(event.id, userId)) {
    await sendToChats(organisers, attendeeMessage('New attendee', event, row, await goingCount(event.id)));
  }
}

// Someone reported paying: the admins, so someone checks it.
export async function alertPaymentReported(event, userId) {
  const admins = adminChatIds();
  if (admins.length === 0) {
    return;
  }
  const row = await attendeeRow(event.id, userId);
  if (row) {
    await sendToChats(admins, attendeeMessage('Payment reported', event, row, await goingCount(event.id)));
  }
}

// An editor confirmed a payment: the admins and the organisers.
export async function alertPaymentConfirmed(event, userId) {
  const chats = parseChatIds([...adminChatIds(), ...organiserChatIds(event)]);
  if (chats.length === 0) {
    return;
  }
  const row = await attendeeRow(event.id, userId);
  if (row) {
    await sendToChats(chats, attendeeMessage('Payment confirmed', event, row, await goingCount(event.id)));
  }
}

// ---------------------------------------------------------------------------
// New events, for the admins
// ---------------------------------------------------------------------------

// The admins' message about a newly published event.
export function newEventMessage(row) {
  const details = [['Kind', nameFrom(KIND_NAMES, row.kind)], ['When', whenText(row)]];
  const where = placeText(row);
  if (where) {
    details.push(['Where', where]);
  }
  if (row.organiser_name) {
    details.push(['Organiser', row.organiser_name]);
  }
  return staffAlertMessage({ heading: 'New event published', title: row.title, details, contact: [], url: `${siteUrl()}/e/${row.slug}` });
}

// Before a save (row: the event as it will be, with admin_told_at): when the
// admins' notice of it is due, as the columns to save, or {} when there is
// none to send. Each save of a published event they have not heard about
// moves it changeNotice.waitMs ahead, or to its release time when that is
// later.
export function queueAdminEventNotice(row, now = Date.now()) {
  if (row.status !== 'published' || row.admin_told_at || adminChatIds().length === 0) {
    return {};
  }
  let due = now + changeNotice.waitMs;
  if (row.publish_at && Date.parse(row.publish_at) > due) {
    due = Date.parse(row.publish_at);
  }
  return { admin_notice_due_at: new Date(due).toISOString() };
}

// Sends an event's admins' notice once it is due, released and still not
// sent; claimed first, so it goes once. A published event whose release is
// still to come waits for it; one put back to draft forgets the notice.
export async function flushAdminEvent(eventId, now = Date.now()) {
  const { data: row, error } = await database()
    .from(TABLES.events)
    .select('id, slug, title, kind, status, publish_at, starts_at, ends_at, start_time_tbc, timezone, dates_hidden, venue_name, city, is_online, organiser_name, admin_told_at, admin_notice_due_at')
    .eq('id', eventId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!row || !row.admin_notice_due_at || new Date(row.admin_notice_due_at).getTime() > now) {
    return false;
  }
  let columns = { admin_notice_due_at: null, admin_told_at: new Date(now).toISOString() };
  let send = true;
  if (row.admin_told_at || row.status !== 'published') {
    columns = { admin_notice_due_at: null };
    send = false;
  } else if (!isReleased(row, now)) {
    columns = { admin_notice_due_at: new Date(Date.parse(row.publish_at)).toISOString() };
    send = false;
  }
  const { data: claimed, error: claimError } = await database()
    .from(TABLES.events)
    .update(columns)
    .eq('id', eventId)
    .eq('admin_notice_due_at', row.admin_notice_due_at)
    .select('id');
  if (claimError) {
    throw claimError;
  }
  if (!send || !Array.isArray(claimed) || claimed.length !== 1) {
    return false;
  }
  await sendToChats(adminChatIds(), newEventMessage(row));
  return true;
}

// After a save that queued it, in the background: waits until it is due.
export async function sendAdminEventWhenDue(eventId) {
  await new Promise((resolve) => {
    setTimeout(resolve, changeNotice.waitMs + changeNotice.graceMs);
  });
  return flushAdminEvent(eventId);
}

// Each cron run: the admins' notices whose background send never ran, or
// whose event has reached its release time. Returns how many went.
export async function flushDueAdminEvents(now = Date.now()) {
  const { data, error } = await database()
    .from(TABLES.events)
    .select('id')
    .lte('admin_notice_due_at', new Date(now).toISOString())
    .limit(100);
  if (error) {
    throw error;
  }
  let sent = 0;
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  }
  for (const row of rows) {
    if (await flushAdminEvent(row.id, now)) {
      sent += 1;
    }
  }
  return sent;
}

// A short test message to each of an event's organisers' chats, from the
// Organisers tab; returns the chats it could not reach.
export function testOrganiserChats(event, chatIds) {
  const message = staffAlertMessage({
    heading: 'Organiser alerts are on',
    title: event.title,
    details: [['What', 'New attendees, once their details are complete, and payments once confirmed']],
    contact: [],
    url: `${siteUrl()}/e/${event.slug}`,
  });
  return sendToChats(chatIds, message);
}
