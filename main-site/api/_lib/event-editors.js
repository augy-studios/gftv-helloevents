// Editors for one event (migrations/018). An admin can make any account an
// editor of a specific event; staff editors and admins edit every event.
//
// An event editor's rights work only while their account has two-step
// sign-in on (an authenticator app or a passkey; staff always have it, as
// they cannot sign in without it). Without it, they edit nothing until they
// turn it on: they would see attendees' names, countries and payments.
//
// What an event editor may not do on their events (change the Status or the
// release time, delete) is held back by the routes that do it
// (api/manage/events.js).

import { database, TABLES } from './supabase.js';
import { canManage } from './users.js';
import { methodsFor, hasSecondFactor } from './factors.js';

// Whether this account has two-step sign-in on, as an event editor needs.
export async function hasTwoStep(user) {
  if (user.kind === 'staff') {
    return true;
  }
  return hasSecondFactor(await methodsFor(user), user);
}

// The ids of the events this account is an editor of (whether or not its
// rights are working).
async function assignedEventIds(accountId) {
  const { data, error } = await database()
    .from(TABLES.eventEditors)
    .select('event_id')
    .eq('account_id', accountId);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((row) => row.event_id);
}

// The events this person may edit: null for every event (staff editors and
// admins), otherwise the ids of the events they edit, [] when none (or while
// they have no two-step sign-in).
export async function editableEventIds(user) {
  if (canManage(user)) {
    return null;
  }
  const ids = await assignedEventIds(user.id);
  if (ids.length === 0 || !(await hasTwoStep(user))) {
    return [];
  }
  return ids;
}

// Whether this person may edit this event.
export async function canEditEvent(user, eventId) {
  if (!user) {
    return false;
  }
  const ids = await editableEventIds(user);
  if (ids === null) {
    return true;
  }
  return ids.includes(eventId);
}

// Whether this person edits any event at all: staff editors and admins, or
// an event editor with two-step sign-in on. The Manage link and page.
export async function editsAnyEvent(user) {
  const ids = await editableEventIds(user);
  if (ids === null) {
    return true;
  }
  return ids.length > 0;
}

// Whether this person is an event editor only (not staff who edit every
// event): the Manage page then shows only their events, without staff tools.
export function eventEditorOnly(user) {
  return !canManage(user);
}
