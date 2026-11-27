// An event's own editors (migrations/018) and its organisers' Telegram
// chats (migrations/026), for the Organisers tab of the edit form on
// /manage. Admins only.
//
// GET  ?id=<event id>                                 -> { editors, candidates, organiserChats }
// GET  ?id=<event id>&search=<typed text>              -> { candidates }
// POST { id, action: "add", username, staff? }         -> { editors, candidates, organiserChats }
// POST { id, action: "remove", username, staff }       -> { editors, candidates, organiserChats }
// POST { id, action: "chats", chats }                  -> { editors, candidates, organiserChats }
// POST { id, action: "test-chats" }                    -> { failed }
//
// chats: the organisers' chat ids, as text (separated by commas, spaces or
// new lines) or a list: a person's id, or a group's (starting with -), at
// most MAX_ORGANISER_CHATS. Anything else is refused with chat_id_invalid
// (and the value), more with too_many_chats. The bot then tells them about
// the event's new attendees and confirmed payments (staff-alerts.js).
// test-chats: a short message to each saved chat; failed lists those the
// bot could not reach (not in the group, or the person never pressed Start).
//
// editors: each editor's username, display name, staff or not, and whether
// their rights are working (twoStep: two-step sign-in is on; without it
// they edit nothing until it is).
// candidates: the accounts an admin can add, for the dropdown: active ones
// that signed in within the last 30 days, not already able to edit every
// event (staff editors and admins) and not already this event's editors,
// most recent first. Usernames and display names only. With search: any
// active account, however long since it signed in, whose username or
// display name holds the text typed, those starting with it first (at most
// MAX_RESULTS), for the dropdown as an admin types. Adding one takes any
// active account by its username, likewise.
//
// An account is named by its username (and staff or not, when the page
// knows: a staff member and a public account can share a username).

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { canManage, normaliseAccount } from '../_lib/users.js';
import { hasTwoStep } from '../_lib/event-editors.js';
import { parseChatIds, organiserChatIds, testOrganiserChats, MAX_ORGANISER_CHATS } from '../_lib/staff-alerts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_DAYS = 30;
const MAX_CANDIDATES = 500;
const MAX_RESULTS = 20;
const MAX_SEARCH = 40;
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

// Text typed into the search, safe inside a PostgREST or() filter and an
// ilike pattern: no commas, brackets, quotes, wildcards or backslashes.
function searchText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[,()*%\\"'.:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH);
}

// Active accounts that could be added: those whose username or display
// name holds text (or, exact, whose username is text), staff members
// (found by their staff record) and public accounts alike, not able to
// edit every event already nor this event's editors.
async function searchAccounts(editorIds, typed, { exact = false } = {}) {
  const text = searchText(typed);
  if (!text) {
    return [];
  }
  let publicQuery = database().from(TABLES.accounts).select(ACCOUNT_SELECT).eq('kind', 'public').eq('status', 'active');
  let staffQuery = database().from(TABLES.users).select('id');
  if (exact) {
    publicQuery = publicQuery.eq('username', text.toLowerCase());
    staffQuery = staffQuery.eq('username', text);
  } else {
    const filter = `username.ilike.%${text}%,display_name.ilike.%${text}%`;
    publicQuery = publicQuery.or(filter).order('username', { ascending: true }).limit(MAX_CANDIDATES);
    staffQuery = staffQuery.or(filter).limit(MAX_CANDIDATES);
  }
  const [publicFound, staffFound] = await Promise.all([publicQuery, staffQuery]);
  if (publicFound.error) {
    throw publicFound.error;
  }
  if (staffFound.error) {
    throw staffFound.error;
  }
  let staffRows = [];
  const staffIds = rowsOf(staffFound.data).map((row) => row.id);
  if (staffIds.length > 0) {
    const { data, error } = await database().from(TABLES.accounts).select(ACCOUNT_SELECT).in('id', staffIds).eq('status', 'active');
    if (error) {
      throw error;
    }
    staffRows = rowsOf(data);
  }
  return [...rowsOf(publicFound.data), ...staffRows]
    .map((row) => normaliseAccount(row))
    .filter((account) => {
      if (!account || !account.username || canManage(account)) {
        return false;
      }
      return !editorIds.has(account.id);
    });
}

// The accounts the dropdown lists for text typed: usernames starting with
// it first, then display names starting with it, then the rest, each
// alphabetically.
function ranked(accounts, typed) {
  const wanted = searchText(typed).toLowerCase();
  const rank = (account) => {
    const person = personOf(account);
    if (person.username.toLowerCase().startsWith(wanted)) {
      return 0;
    }
    if (person.displayName.toLowerCase().startsWith(wanted)) {
      return 1;
    }
    return 2;
  };
  return accounts
    .map((account) => ({ account, rank: rank(account) }))
    .sort((first, second) => {
      if (first.rank !== second.rank) {
        return first.rank - second.rank;
      }
      return first.account.username.localeCompare(second.account.username);
    })
    .slice(0, MAX_RESULTS)
    .map((each) => personOf(each.account));
}

async function answer(response, eventId, event) {
  const editors = await editorAccounts(eventId);
  const editorIds = new Set(editors.map((account) => account.id));
  const shown = [];
  for (const account of editors) {
    shown.push({ ...personOf(account), twoStep: await hasTwoStep(account) });
  }
  const candidates = (await candidateAccounts(editorIds)).map(personOf);
  return ok(response, { editors: shown, candidates, organiserChats: organiserChatIds(event) });
}

// The chat ids an admin typed: { ok: true, chats } or { ok: false, error,
// value }.
function readChats(input) {
  let parts = [];
  if (Array.isArray(input)) {
    parts = input.map((part) => String(part).trim()).filter(Boolean);
  } else if (typeof input === 'string') {
    parts = input.split(/[\s,;]+/).filter(Boolean);
  } else {
    return { ok: false, error: 'bad_request', value: null };
  }
  for (const part of parts) {
    if (parseChatIds([part]).length === 0) {
      return { ok: false, error: 'chat_id_invalid', value: part.slice(0, 40) };
    }
  }
  const chats = parseChatIds(parts);
  if (chats.length > MAX_ORGANISER_CHATS) {
    return { ok: false, error: 'too_many_chats', value: null };
  }
  return { ok: true, chats };
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
  const { data: event, error } = await database().from(TABLES.events).select('id, slug, title, organiser_chat_ids').eq('id', eventId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  if (request.method === 'GET' && query(request, 'search') !== '') {
    const editorIds = new Set((await editorAccounts(eventId)).map((account) => account.id));
    const typed = query(request, 'search');
    return ok(response, { candidates: ranked(await searchAccounts(editorIds, typed), typed) });
  }
  if (request.method === 'GET') {
    await answer(response, eventId, event);
    return;
  }
  if (body.action === 'chats') {
    const read = readChats(body.chats);
    if (!read.ok) {
      const extra = {};
      if (read.value) {
        extra.value = read.value;
      }
      return fail(response, 400, read.error, extra);
    }
    const { data: saved, error: saveError } = await database()
      .from(TABLES.events)
      .update({ organiser_chat_ids: read.chats })
      .eq('id', eventId)
      .select('id, slug, title, organiser_chat_ids')
      .single();
    if (saveError) {
      throw saveError;
    }
    await audit(request, { action: 'event.organiser_chats_changed', actorId: session.user.id, eventId, details: { count: read.chats.length } });
    await answer(response, eventId, saved);
    return;
  }
  if (body.action === 'test-chats') {
    const chats = organiserChatIds(event);
    if (chats.length === 0) {
      return fail(response, 400, 'no_chats');
    }
    return ok(response, { failed: await testOrganiserChats(event, chats) });
  }

  const editors = await editorAccounts(eventId);
  if (body.action === 'add') {
    const account = named(await searchAccounts(new Set(editors.map((each) => each.id)), body.username, { exact: true }), body);
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
  await answer(response, eventId, event);
});
