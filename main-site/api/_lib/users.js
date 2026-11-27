// Accounts. Two kinds, one shape (migrations/002):
//
//   staff   gftvhello_users, owned by gftv.asia and read only here. Its row in
//           gftvevents_accounts has the same id and only exists so sessions,
//           RSVPs and second factors have one table to point at.
//   public  a gftvevents_accounts row of its own: username, display name,
//           email and a bcrypt password, made by /api/auth/signup.
//
// Everything above this file works with the normalised account below, so a
// route never has to care which kind it has, except where the rules differ:
//
//   Sign in   staff need is_approved; public need status "active".
//   2FA       mandatory for staff, optional for public accounts.
//   Manage    staff only: is_approved and is_editor or is_admin. Only admins
//             delete events.
//
// The column lists are the only things that ever select from either table.
// Emails are read for sign-in lookups only and never leave this module.

import { database, TABLES } from './supabase.js';
import { optionalEnv } from './env.js';

const STAFF_COLUMNS = 'id, username, display_name, avatar_url, is_admin, is_editor, is_approved';
const STAFF_AUTH_COLUMNS = `${STAFF_COLUMNS}, password_hash, totp_secret`;
const ACCOUNT_COLUMNS =
  'id, kind, username, display_name, status, notify_updates, notify_reminders, reminder_hours, notify_new_events, notify_telegram, country, ' +
  'legal_name, date_of_birth, emergency_name, emergency_phone, id_verified_providers, helloid_pending';

// When reminders can come, in hours before an event starts (migrations/011):
// 1, 2 and 3 hours, a day and a week. An account picks any of them.
export const REMINDER_HOURS = [1, 2, 3, 24, 168];
// What an account has before it picks (and a staff member with no accounts
// row yet): a day before.
const DEFAULT_REMINDER_HOURS = [24];

// The reminder times in a stored or sent list: the allowed ones, each once,
// soonest last ([168, 24, 1] for a week, a day and an hour). Anything else is
// left out.
export function reminderHoursFrom(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return REMINDER_HOURS.filter((hours) => list.some((each) => Number(each) === hours)).reverse();
}
const ACCOUNT_AUTH_COLUMNS = `${ACCOUNT_COLUMNS}, password_hash`;

// For a session lookup: the account row with its staff record embedded.
export const SESSION_ACCOUNT_SELECT = `${ACCOUNT_COLUMNS}, staff:${TABLES.users} ( ${STAFF_COLUMNS} )`;

// The one shape every route sees. password_hash and totp_secret are only
// present when the account was loaded with { withSecrets: true }.
function fromStaff(staff, account = null) {
  let avatarUrl = staff.avatar_url;
  if (avatarUrl === undefined) {
    avatarUrl = null;
  }
  const normalised = {
    id: staff.id,
    kind: 'staff',
    username: staff.username,
    display_name: staff.display_name,
    avatar_url: avatarUrl,
    is_admin: staff.is_admin === true,
    is_editor: staff.is_editor === true,
    is_approved: staff.is_approved === true,
    country: countryOf(account),
    personal: personalDetails(account),
    idVerified: idVerifiedOf(account),
    helloidPending: helloidPendingOf(account),
    prefs: notificationPreferences(account),
  };
  if ('password_hash' in staff) {
    let totpSecret = staff.totp_secret;
    if (totpSecret === undefined) {
      totpSecret = null;
    }
    normalised.password_hash = staff.password_hash;
    normalised.totp_secret = totpSecret;
  }
  return normalised;
}

function fromPublic(account) {
  const normalised = {
    id: account.id,
    kind: 'public',
    username: account.username,
    display_name: account.display_name,
    avatar_url: null,
    is_admin: false,
    is_editor: false,
    is_approved: account.status === 'active',
    country: countryOf(account),
    personal: personalDetails(account),
    idVerified: idVerifiedOf(account),
    helloidPending: helloidPendingOf(account),
    prefs: notificationPreferences(account),
  };
  if ('password_hash' in account) {
    normalised.password_hash = account.password_hash;
    normalised.totp_secret = null;
  }
  return normalised;
}

// The account's country of origin (migrations/015), a two-letter code, or
// null while it has none (and for a staff member with no accounts row yet).
function countryOf(account) {
  if (account && typeof account.country === 'string' && account.country !== '') {
    return account.country;
  }
  return null;
}

// The ID check providers the account has passed with (migrations/027,
// id-checks.js), or none.
function idVerifiedOf(account) {
  if (account && Array.isArray(account.id_verified_providers)) {
    return account.id_verified_providers.filter((name) => typeof name === 'string');
  }
  return [];
}

// Whether a HelloID check of the account waits for the admins.
function helloidPendingOf(account) {
  if (account && account.helloid_pending === true) {
    return true;
  }
  return false;
}

// The account's personal details (migrations/024): { legalName,
// dateOfBirth ('YYYY-MM-DD'), emergencyName, emergencyPhone }, each null
// while blank (and for a staff member with no accounts row yet). They leave
// the server only to the person themselves (serialize.js selfView), and to
// the editors of an event whose registration form asks for them.
export function personalDetails(account) {
  const text = (value) => {
    if (typeof value === 'string' && value !== '') {
      return value;
    }
    return null;
  };
  let row = account;
  if (row === null || row === undefined) {
    row = {};
  }
  let dateOfBirth = text(row.date_of_birth);
  if (dateOfBirth) {
    dateOfBirth = dateOfBirth.slice(0, 10);
  }
  return {
    legalName: text(row.legal_name),
    dateOfBirth,
    emergencyName: text(row.emergency_name),
    emergencyPhone: text(row.emergency_phone),
  };
}

// The account's notification choices. Updates are on unless switched off;
// reminders come at the times picked (a day before until something else is
// picked); new events and Telegram are off unless switched on. A staff
// member with no accounts row yet (account null) has the defaults.
function notificationPreferences(account) {
  let row = account;
  if (row === null || row === undefined) {
    row = {};
  }
  let reminderHours = DEFAULT_REMINDER_HOURS;
  if (Array.isArray(row.reminder_hours)) {
    reminderHours = reminderHoursFrom(row.reminder_hours);
  } else if (row.notify_reminders === false) {
    reminderHours = [];
  }
  return {
    updates: row.notify_updates !== false,
    reminderHours,
    newEvents: row.notify_new_events === true,
    telegram: row.notify_telegram === true,
  };
}

// Where a staff member's profile picture (set on gftv.asia) is fetched from
// by api/me/avatar.js: its https address, but only when it is in this site's
// own Supabase project, the one place it is fetched from; otherwise null.
// The address itself never goes to a browser.
export function avatarSource(account) {
  if (!account || typeof account.avatar_url !== 'string') {
    return null;
  }
  let picture;
  let project;
  try {
    picture = new URL(account.avatar_url);
    project = new URL(optionalEnv('SUPABASE_URL'));
  } catch {
    return null;
  }
  if (picture.protocol !== 'https:' || picture.host !== project.host || picture.username || picture.password) {
    return null;
  }
  return picture.href;
}

// An account row from SESSION_ACCOUNT_SELECT, normalised, or null.
export function normaliseAccount(row) {
  if (!row) {
    return null;
  }
  if (row.kind === 'staff') {
    if (row.staff) {
      return fromStaff(row.staff, row);
    }
    return null;
  }
  if (row.kind === 'public') {
    return fromPublic(row);
  }
  return null;
}

export function canSignIn(account) {
  if (account && account.is_approved === true) {
    return true;
  }
  return false;
}

export function canManage(account) {
  if (canSignIn(account) && account.kind === 'staff' && (account.is_admin === true || account.is_editor === true)) {
    return true;
  }
  return false;
}

export function isAdmin(account) {
  if (canManage(account) && account.is_admin === true) {
    return true;
  }
  return false;
}

export function roleOf(account) {
  if (isAdmin(account)) {
    return 'admin';
  }
  if (canManage(account)) {
    return 'editor';
  }
  if (account && account.kind === 'staff') {
    return 'staff';
  }
  return 'member';
}

// Staff must have a second factor; public accounts choose.
export function secondFactorRequired(account) {
  if (account && account.kind === 'staff') {
    return true;
  }
  return false;
}

// The staff record's row in gftvevents_accounts, made the first time it is
// needed. Same id, so nothing else has to be rewritten.
export async function ensureStaffAccount(staffUserId) {
  const { error } = await database()
    .from(TABLES.accounts)
    .upsert({ id: staffUserId, kind: 'staff', staff_user_id: staffUserId }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    throw error;
  }
}

// A username or an email. Staff are looked up the way gftv-linktree does (two
// exact lookups on lowercased input, never an .or() built from it); public
// accounts the same way. Returns { staff, member }, either of which may be
// null, both with their password hashes, so the caller can check the
// password against each.
export async function findForLogin(identifier) {
  let typed = identifier;
  if (typed === null || typed === undefined) {
    typed = '';
  }
  const lookup = String(typed).trim().toLowerCase();
  if (!lookup || lookup.length > 254 || /\s/.test(lookup)) {
    return { staff: null, member: null };
  }
  let column = 'username';
  if (lookup.includes('@')) {
    column = 'email';
  }
  const [staffResult, memberResult] = await Promise.all([
    database().from(TABLES.users).select(STAFF_AUTH_COLUMNS).eq(column, lookup).maybeSingle(),
    database().from(TABLES.accounts).select(ACCOUNT_AUTH_COLUMNS).eq('kind', 'public').eq(column, lookup).maybeSingle(),
  ]);
  if (staffResult.error) {
    throw staffResult.error;
  }
  if (memberResult.error) {
    throw memberResult.error;
  }
  let staff = null;
  if (staffResult.data) {
    staff = fromStaff(staffResult.data);
  }
  let member = null;
  if (memberResult.data) {
    member = fromPublic(memberResult.data);
  }
  return { staff, member };
}

// One gftvhello_users row by id, normalised, or null. account is the staff
// member's gftvevents_accounts row, when there is one.
async function loadStaff(staffUserId, columns, account) {
  const { data: staff, error } = await database()
    .from(TABLES.users)
    .select(columns)
    .eq('id', staffUserId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (staff) {
    return fromStaff(staff, account);
  }
  return null;
}

// An account by id, normalised. { withSecrets: true } adds the password hash
// and the shared TOTP secret, for the routes that check them.
// A staff member is read from gftvhello_users, through their accounts row
// when it exists, or directly by the same id when it does not exist yet.
export async function loadAccount(accountId, { withSecrets = false } = {}) {
  let accountColumns = ACCOUNT_COLUMNS;
  let staffColumns = STAFF_COLUMNS;
  if (withSecrets) {
    accountColumns = ACCOUNT_AUTH_COLUMNS;
    staffColumns = STAFF_AUTH_COLUMNS;
  }
  const { data, error } = await database()
    .from(TABLES.accounts)
    .select(accountColumns + ', staff_user_id')
    .eq('id', accountId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    // A staff member whose accounts row does not exist yet.
    return loadStaff(accountId, staffColumns, null);
  }
  if (data.kind === 'public') {
    return fromPublic(data);
  }
  return loadStaff(data.staff_user_id, staffColumns, data);
}

// Is this username or email free for a new public account? Checks staff
// accounts too, so nobody can sign up as a staff member's username or email.
export async function identityTaken({ username, email }) {
  const checks = await Promise.all([
    database().from(TABLES.accounts).select('id').eq('username', username).maybeSingle(),
    database().from(TABLES.users).select('id').eq('username', username).maybeSingle(),
    database().from(TABLES.accounts).select('id').eq('email', email).maybeSingle(),
    database().from(TABLES.users).select('id').eq('email', email).maybeSingle(),
  ]);
  for (const check of checks) {
    if (check.error) {
      throw check.error;
    }
  }
  const [accountByUsername, staffByUsername, accountByEmail, staffByEmail] = checks;
  if (accountByUsername.data || staffByUsername.data) {
    return 'username_taken';
  }
  if (accountByEmail.data || staffByEmail.data) {
    return 'email_taken';
  }
  return null;
}
