// An event's own editors (migrations/018), for the Editors tab of the edit
// form on /manage. Admins only.
//
// GET  ?id=<event id>                                 -> { editors, candidates }
// POST { id, action: "add", username, staff? }         -> { editors, candidates }
// POST { id, action: "remove", username, staff }       -> { editors, candidates }
//
// editors: each editor's username, display name, staff or not, and whether
// their rights are working (twoStep: two-step sign-in is on; without it
// they edit nothing until it is).
// candidates: the accounts an admin can add, for the dropdown: active ones
// that signed in within the last 30 days, not already able to edit every
// event (staff editors and admins) and not already this event's editors,
// most recent first. Usernames and display names only.
//
// An account is named by its username (and staff or not, when the page
// knows: a staff member and a public account can share a username).

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canManage, normaliseAccount } from '../_lib/users.js';
import { hasTwoStep } from '../_lib/event-editors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_DAYS = 30;
const MAX_CANDIDATES = 500;
// What normaliseAccount and canManage read, with the staff record embedded.
const ACCOUNT_SELECT = `id, kind, username, display_name, status, last_sign_in_at, staff:${TABLES.users} ( id, username, display_name, is_admin, is_editor, is_approved )`;

function rowsOf(data) {
  if (Array.isArray(data)) {
    return data;
  }
  return [];
}

// An account as the tab shows it: username, display name, staff or not.
function personOf(account) {
  let displayName = account.display_name;
  if (!displayName) {
    displayName = account.username;
  }
  return { username: account.username, displayName, staff: account.kind === 'staff' };
}

// This event's editors, as normalised accounts, oldest first.
async function editorAccounts(eventId) {
  const { data, error } = await database()
    .from(TABLES.eventEditors)
    .select(`created_at, account:${TABLES.accounts}!account_id ( ${ACCOUNT_SELECT} )`)
    .eq('event_id', eventId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  return rowsOf(data).map((row) => normaliseAccount(row.account)).filter(Boolean);
}

// Accounts active in the last ACTIVE_DAYS days that could be added.
async function candidateAccounts(editorIds) {
  const since = new Date(Date.now() - ACTIVE_DAYS * 86400_000).toISOString();
  const { data, error } = await database()
    .from(TABLES.accounts)
    .select(ACCOUNT_SELECT)
    .eq('status', 'active')
    .gte('last_sign_in_at', since)
    .order('last_sign_in_at', { ascending: false })
    .limit(MAX_CANDIDATES);
  if (error) {
    throw error;
  }
  return rowsOf(data)
    .map((row) => normaliseAccount(row))
    .filter((account) => {
      if (!account || !account.username) {
        return false;
      }
      if (canManage(account)) {
        return false;
      }
      return !editorIds.has(account.id);
    });
}

async function answer(response, eventId) {
  const editors = await editorAccounts(eventId);
  const editorIds = new Set(editors.map((account) => account.id));
  const shown = [];
  for (const account of editors) {
    shown.push({ ...personOf(account), twoStep: await hasTwoStep(account) });
  }
  const candidates = (await candidateAccounts(editorIds)).map(personOf);
  return ok(response, { editors: shown, candidates });
}

// The account an admin named, among those that could be added (add) or
// this event's editors (remove), or null.
function named(accounts, body) {
  let username = '';
  if (typeof body.username === 'string') {
    username = body.username.trim();
  }
  if (!username) {
    return null;
  }
  const matches = accounts.filter((account) => account.username === username);
  const exact = matches.filter((account) => {
    if (typeof body.staff !== 'boolean') {
      return true;
    }
    return (account.kind === 'staff') === body.staff;
  });
  // A name both a staff member and a public account have, with no word on
  // which: the public account (the usual case for an event editor).
  const publicMatch = exact.find((account) => account.kind === 'public');
  if (publicMatch) {
    return publicMatch;
  }
  if (exact.length > 0) {
    return exact[0];
  }
  return null;
}

export default route('manage/event-editors', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { admin: true });
  if (!session) {
    return;
  }
  let body = {};
  let eventId = query(request, 'id');
  if (request.method === 'POST') {
    body = await readJson(request, response);
    if (!body) {
      return;
    }
    if (await limited(request, response, 'manageWrite', [`u:${session.user.id}`])) {
      return;
    }
    eventId = String(body.id);
  }
  if (!UUID_PATTERN.test(eventId)) {
    return fail(response, 400, 'bad_request');
  }
  eventId = eventId.toLowerCase();
  const { data: event, error } = await database().from(TABLES.events).select('id').eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  if (request.method === 'GET') {
    await answer(response, eventId);
    return;
  }

  const editors = await editorAccounts(eventId);
  if (body.action === 'add') {
    const account = named(await candidateAccounts(new Set(editors.map((each) => each.id))), body);
    if (!account) {
      return fail(response, 404, 'editor_not_found');
    }
    const { error: addError } = await database()
      .from(TABLES.eventEditors)
      .insert({ event_id: eventId, account_id: account.id, added_by: session.user.id });
    if (addError) {
      throw addError;
    }
    await audit(request, { action: 'event.editor_added', actorId: session.user.id, eventId, details: { username: account.username } });
  } else if (body.action === 'remove') {
    const account = named(editors, body);
    if (!account) {
      return fail(response, 404, 'not_found');
    }
    const { error: removeError } = await database()
      .from(TABLES.eventEditors)
      .delete()
      .eq('event_id', eventId)
      .eq('account_id', account.id);
    if (removeError) {
      throw removeError;
    }
    await audit(request, { action: 'event.editor_removed', actorId: session.user.id, eventId, details: { username: account.username } });
  } else {
    return fail(response, 400, 'bad_request');
  }
  await answer(response, eventId);
});
