// The staff tools on /manage beside the events (help desk #7, round 4).
//
// GET -> { filters, builtIn, flagged }   admins; {} for other editors
//
// (The venue sign-up allowances that were here went with the per-connection
// sign-up limit, migrations/027.)
//
// Admins only:
//   POST { action: "filter-add", term }      a word public names may not use
//   POST { action: "filter-remove", id }
//   POST { action: "reset-issue", username } a one-time password reset code
//        for a public account, shown once, valid 24 hours, for someone with
//        neither Telegram nor 2FA whose identity was checked another way.
//        Making a new one cancels the last. -> { code, expiresAt }
//   POST { action: "personal-fix", username, legalName?, dateOfBirth?, country? }
//        (migrations/024) correct a locked personal detail on any account
//        (public, or staff by their gftv.asia username), after checking who
//        they are. A blank value clears it, so they can fill it in again.
//        Correcting the legal name or date of birth also takes away the
//        account's ID check (migrations/027), so they check again.
//        -> { fixed: [the details changed] }
//
// Every write is in the audit log. Answers carry no IP hash, email or id of
// a person; flagged names are a username and a display name.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { isAdmin } from '../_lib/users.js';
import { randomBytesCode, sha256 } from '../_lib/crypto.js';
import { countryCode } from '../_lib/countries.js';
import { ensureStaffAccount } from '../_lib/users.js';
import { personName, birthDate } from '../../js/registration-fields.js';
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

// GET: the word list, the built-in words and the flagged names, for
// admins; nothing for other editors, who have no staff tools.
async function showTools(response, admin) {
  if (!admin) {
    return ok(response, {});
  }
  return ok(response, { filters: await filters(), builtIn: BUILT_IN_TERMS, flagged: await flagged() });
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

// The account a username names: a public account's, or a staff member's
// (by their gftv.asia username): { id, kind } or null.
async function accountByUsername(username) {
  const { data: account, error } = await database()
    .from(TABLES.accounts)
    .select('id, kind')
    .eq('kind', 'public')
    .eq('username', username)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (account) {
    return account;
  }
  const { data: staff, error: staffError } = await database()
    .from(TABLES.users)
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (staffError) {
    throw staffError;
  }
  if (!staff) {
    return null;
  }
  await ensureStaffAccount(staff.id);
  return { id: staff.id, kind: 'staff' };
}

// "personal-fix": corrects a locked personal detail (migrations/024).
async function fixPersonal(request, response, body, user) {
  const username = stringOrEmpty(body.username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,64}$/.test(username)) {
    return fail(response, 400, 'bad_request');
  }
  const changes = {};
  if (body.legalName !== undefined) {
    const name = personName(body.legalName);
    if (!name.ok) {
      return fail(response, 400, 'legal_name_invalid');
    }
    changes.legal_name = null;
    if (name.value) {
      changes.legal_name = name.value;
    }
  }
  if (body.dateOfBirth !== undefined) {
    const date = birthDate(body.dateOfBirth);
    if (!date.ok) {
      return fail(response, 400, 'date_of_birth_invalid');
    }
    changes.date_of_birth = null;
    if (date.value) {
      changes.date_of_birth = date.value;
    }
  }
  if (body.country !== undefined) {
    if (body.country === '' || body.country === null) {
      changes.country = null;
    } else {
      const country = countryCode(body.country);
      if (!country) {
        return fail(response, 400, 'country_required');
      }
      changes.country = country;
    }
  }
  if (Object.keys(changes).length === 0) {
    return fail(response, 400, 'bad_request');
  }
  const account = await accountByUsername(username);
  if (!account) {
    return fail(response, 404, 'account_not_found');
  }
  const fixed = Object.keys(changes);
  // An ID check vouched for the name and date of birth it read
  // (migrations/027): correcting either takes the check away, and the
  // person checks again.
  if ('legal_name' in changes || 'date_of_birth' in changes) {
    changes.id_verified_providers = [];
    changes.id_verified_at = null;
  }
  const { error } = await database().from(TABLES.accounts).update(changes).eq('id', account.id);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'admin.personal_fixed', actorId: user.id, details: { username, fields: fixed } });
  return ok(response, { fixed });
}

// Sends each request to its step: all of them for admins only. Every POST
// counts against the manageWrite limit.
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
    await showTools(response, admin);
    return;
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'manageWrite', [`u:${user.id}`])) {
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
  if (body.action === 'personal-fix') {
    await fixPersonal(request, response, body, user);
    return;
  }
  fail(response, 400, 'bad_request');
});
