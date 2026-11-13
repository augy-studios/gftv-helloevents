// The staff tools on /manage beside the events (help desk #7, round 4).
//
// GET -> { allowances, here, filters?, builtIn?, flagged? }
//
// Editors and admins:
//   POST { action: "allowance-grant", hours, perHour, label? }
//        "Venue mode": raise the sign-up limit for the connection this staff
//        member is on right now (its salted IP hash, never the address), for
//        1 to 12 hours, to 20 to 500 sign-ups an hour. For a con or meet
//        where everyone shares the venue's Wi-Fi. Nothing to hand out: the
//        allowance belongs to the connection, and ends by itself.
//   POST { action: "allowance-revoke", id }
//
// Admins only:
//   POST { action: "filter-add", term }      a word public names may not use
//   POST { action: "filter-remove", id }
//   POST { action: "reset-issue", username } a one-time password reset code
//        for a public account, shown once, valid 24 hours, for someone with
//        neither Telegram nor 2FA whose identity was checked another way.
//        Making a new one cancels the last. -> { code, expiresAt }
//
// Every write is in the audit log. Answers carry no IP hash, email or id of
// a person; flagged names are a username and a display name.

import { route, guard, readJson, ok, fail, clientIp } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { isAdmin } from '../_lib/users.js';
import { hashIp, randomBytesCode, sha256 } from '../_lib/crypto.js';
import { fold, blockedTerm, customTerms, forgetNameFilters, BUILT_IN_TERMS } from '../_lib/name-filter.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESET_HOURS = 24;

// Whether a body field is a UUID, once turned into a string (a missing field
// is read as '', which is not).
function isUuid(value) {
  let text = '';
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  return UUID_PATTERN.test(text);
}

// The value as a string, with null and undefined read as ''.
function stringOrEmpty(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// A query's rows, or an empty list when it gave back none.
function rowsOrEmpty(data) {
  if (data === null || data === undefined) {
    return [];
  }
  return data;
}

// Who granted an allowance: a staff member's gftv.asia username, a public
// account's own username, or null when it is not known.
function grantedBy(account) {
  if (account === null || account === undefined) {
    return null;
  }
  if (account.kind === 'staff') {
    const staff = account.staff;
    if (staff === null || staff === undefined) {
      return null;
    }
    if (staff.username === null || staff.username === undefined) {
      return null;
    }
    return staff.username;
  }
  if (account.username === null || account.username === undefined) {
    return null;
  }
  return account.username;
}

// The live sign-up allowances, soonest to end first.
async function allowances(request) {
  const hereHash = hashIp(clientIp(request));
  const { data, error } = await database()
    .from(TABLES.signupAllowances)
    .select(`id, ip_hash, max_per_hour, label, expires_at, by:${TABLES.accounts} ( kind, username, staff:${TABLES.users} ( username ) )`)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(50);
  if (error) {
    throw error;
  }
  return rowsOrEmpty(data).map((row) => {
    let label = null;
    if (row.label) {
      label = row.label;
    }
    return {
      id: row.id,
      perHour: row.max_per_hour,
      label,
      expiresAt: row.expires_at,
      by: grantedBy(row.by),
      // Whether it is for the connection the viewer is on, not which one.
      here: row.ip_hash === hereHash,
    };
  });
}

// The allowances, and whether one of them is for the viewer's connection.
async function allowancesAnswer(request) {
  const list = await allowances(request);
  return { allowances: list, here: list.some((allowance) => allowance.here) };
}

// The admins' own list of words public names may not use.
async function filters() {
  const { data, error } = await database()
    .from(TABLES.nameFilters)
    .select('id, term')
    .order('term', { ascending: true })
    .limit(2000);
  if (error) {
    throw error;
  }
  return rowsOrEmpty(data).map((row) => ({ id: row.id, term: row.term }));
}

// Public accounts whose username or display name now matches a listed word:
// names chosen before the word was listed are left as they are, and shown
// here so an admin can follow up. At most 200.
async function flagged() {
  const adminTerms = await customTerms();
  const { data, error } = await database()
    .from(TABLES.accounts)
    .select('username, display_name')
    .eq('kind', 'public')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) {
    throw error;
  }
  const flaggedNames = [];
  for (const row of rowsOrEmpty(data)) {
    let term = blockedTerm(row.display_name, adminTerms);
    if (!term) {
      term = blockedTerm(row.username, adminTerms);
    }
    if (term) {
      flaggedNames.push({ username: row.username, displayName: row.display_name, term });
    }
    if (flaggedNames.length >= 200) {
      break;
    }
  }
  return flaggedNames;
}

// The word list and the flagged names, after an admin changes the list.
async function filtersAnswer() {
  const filterList = await filters();
  const flaggedNames = await flagged();
  return { filters: filterList, flagged: flaggedNames };
}

// GET: the allowances for every editor; the word list, the built-in words
// and the flagged names for admins too.
async function showTools(request, response, admin) {
  const answer = await allowancesAnswer(request);
  if (admin) {
    answer.filters = await filters();
    answer.builtIn = BUILT_IN_TERMS;
    answer.flagged = await flagged();
  }
  return ok(response, answer);
}

// "allowance-grant": venue mode for the connection this staff member is on.
async function grantAllowance(request, response, body, user) {
  const hours = Number(body.hours);
  const perHour = Number(body.perHour);
  if (!Number.isInteger(hours) || hours < 1 || hours > 12) {
    return fail(response, 400, 'invalid_field', { field: 'hours' });
  }
  if (!Number.isInteger(perHour) || perHour < 20 || perHour > 500) {
    return fail(response, 400, 'invalid_field', { field: 'perHour' });
  }
  // The label without control characters, or null when nothing is left.
  const cleanedLabel = stringOrEmpty(body.label)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 80);
  let label = null;
  if (cleanedLabel) {
    label = cleanedLabel;
  }
  const allowance = {
    ip_hash: hashIp(clientIp(request)),
    max_per_hour: perHour,
    label,
    created_by: user.id,
    expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
  };
  const { data, error } = await database()
    .from(TABLES.signupAllowances)
    .insert(allowance)
    .select('id')
    .single();
  if (error) {
    throw error;
  }
  await audit(request, {
    action: 'admin.signup_allowance_granted',
    actorId: user.id,
    details: { id: data.id, hours, perHour, label },
  });
  return ok(response, { allowances: await allowances(request), here: true });
}

// "allowance-revoke": ends an allowance now.
async function revokeAllowance(request, response, body, user) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const { error } = await database()
    .from(TABLES.signupAllowances)
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', body.id)
    .is('revoked_at', null);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'admin.signup_allowance_revoked', actorId: user.id, details: { id: body.id } });
  return ok(response, await allowancesAnswer(request));
}

// "filter-add": a word public names may not use, compared in its folded
// form. Adding one that is already listed is not an error.
async function addFilter(request, response, body, user) {
  const term = fold(stringOrEmpty(body.term).slice(0, 80));
  if (term.length < 3 || term.length > 40) {
    return fail(response, 400, 'filter_invalid');
  }
  const { error } = await database().from(TABLES.nameFilters).insert({ term, created_by: user.id });
  if (error && error.code !== '23505') {
    throw error;
  }
  forgetNameFilters();
  await audit(request, { action: 'admin.name_filter_added', actorId: user.id, details: { term } });
  return ok(response, await filtersAnswer());
}

// "filter-remove": takes a word off the list.
async function removeFilter(request, response, body, user) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const { data, error } = await database().from(TABLES.nameFilters).delete().eq('id', body.id).select('term');
  if (error) {
    throw error;
  }
  forgetNameFilters();
  // The word removed, for the audit log, or null when there was none.
  let removedTerm = null;
  if (data !== null && data !== undefined) {
    const removed = data[0];
    if (removed !== null && removed !== undefined && removed.term !== null && removed.term !== undefined) {
      removedTerm = removed.term;
    }
  }
  await audit(request, { action: 'admin.name_filter_removed', actorId: user.id, details: { term: removedTerm } });
  return ok(response, await filtersAnswer());
}

// "reset-issue": a one-time password reset code for a public account, shown
// once and valid for RESET_HOURS. Making a new one cancels the last.
async function issueResetCode(request, response, body, user) {
  const username = stringOrEmpty(body.username).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return fail(response, 400, 'bad_request');
  }
  const { data: account, error } = await database()
    .from(TABLES.accounts)
    .select('id, status')
    .eq('kind', 'public')
    .eq('username', username)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!account) {
    return fail(response, 404, 'account_not_found');
  }
  // One live code per account: a new one cancels the last.
  await database().from(TABLES.passwordResets).delete().eq('account_id', account.id).is('used_at', null);
  const code = randomBytesCode();
  const expiresAt = new Date(Date.now() + RESET_HOURS * 3600_000).toISOString();
  // Stored as the SHA-256 of the code without its hyphens, the form
  // recover.js checks a typed code in (normaliseCode).
  const { error: saveError } = await database()
    .from(TABLES.passwordResets)
    .insert({ account_id: account.id, code_hash: sha256(code.replace(/-/g, '')), created_by: user.id, expires_at: expiresAt });
  if (saveError) {
    throw saveError;
  }
  await audit(request, { action: 'admin.password_reset_issued', actorId: user.id, details: { username } });
  return ok(response, { code, expiresAt });
}

// Sends each request to its step. Allowances are for every editor; the
// word list and reset codes are for admins only. Every POST counts against
// the manageWrite limit.
export default route('manage/admin', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true });
  if (!session) {
    return;
  }
  const user = session.user;
  const admin = isAdmin(user);

  if (request.method === 'GET') {
    await showTools(request, response, admin);
    return;
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'manageWrite', [`u:${user.id}`])) {
    return;
  }

  if (body.action === 'allowance-grant') {
    await grantAllowance(request, response, body, user);
    return;
  }
  if (body.action === 'allowance-revoke') {
    await revokeAllowance(request, response, body, user);
    return;
  }

  if (!admin) {
    fail(response, 403, 'admin_only');
    return;
  }
  if (body.action === 'filter-add') {
    await addFilter(request, response, body, user);
    return;
  }
  if (body.action === 'filter-remove') {
    await removeFilter(request, response, body, user);
    return;
  }
  if (body.action === 'reset-issue') {
    await issueResetCode(request, response, body, user);
    return;
  }
  fail(response, 400, 'bad_request');
});
