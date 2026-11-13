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

const STAFF_COLUMNS = 'id, username, display_name, avatar_url, is_admin, is_editor, is_approved';
const STAFF_AUTH_COLUMNS = `${STAFF_COLUMNS}, password_hash, totp_secret`;
const ACCOUNT_COLUMNS =
  'id, kind, username, display_name, status, notify_updates, notify_reminders, notify_new_events, notify_telegram';
const ACCOUNT_AUTH_COLUMNS = `${ACCOUNT_COLUMNS}, password_hash`;

// For a session lookup: the account row with its staff record embedded.
export const SESSION_ACCOUNT_SELECT = `${ACCOUNT_COLUMNS}, staff:${TABLES.users} ( ${STAFF_COLUMNS} )`;

// The one shape every route sees. password_hash and totp_secret are only
// present when the account was loaded with { auth: true }.
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
    prefs: notificationPreferences(account),
  };
  if ('password_hash' in account) {
    normalised.password_hash = account.password_hash;
    normalised.totp_secret = null;
  }
  return normalised;
}

// The account's notification choices. Updates and reminders are on unless
// switched off; new events and Telegram are off unless switched on. A staff
// member with no accounts row yet (account null) has the defaults.
function notificationPreferences(account) {
  let row = account;
  if (row === null || row === undefined) {
    row = {};
  }
  return {
    updates: row.notify_updates !== false,
    reminders: row.notify_reminders !== false,
    newEvents: row.notify_new_events === true,
    telegram: row.notify_telegram === true,
  };
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

// An account by id, normalised. { auth: true } (withSecrets here) adds the
// password hash and the shared TOTP secret, for the routes that check them.
// A staff member is read from gftvhello_users, through their accounts row
// when it exists, or directly by the same id when it does not exist yet.
export async function loadAccount(accountId, { auth: withSecrets = false } = {}) {
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
