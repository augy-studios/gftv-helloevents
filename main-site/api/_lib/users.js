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

import { db, T } from './supabase.js';

const STAFF_COLUMNS = 'id, username, display_name, avatar_url, is_admin, is_editor, is_approved';
const STAFF_AUTH_COLUMNS = `${STAFF_COLUMNS}, password_hash, totp_secret`;
const ACCOUNT_COLUMNS =
  'id, kind, username, display_name, status, notify_updates, notify_reminders, notify_new_events, notify_telegram';
const ACCOUNT_AUTH_COLUMNS = `${ACCOUNT_COLUMNS}, password_hash`;

// For a session lookup: the account row with its staff record embedded.
export const SESSION_ACCOUNT_SELECT = `${ACCOUNT_COLUMNS}, staff:${T.users} ( ${STAFF_COLUMNS} )`;

// The one shape every route sees. password_hash and totp_secret are only
// present when the account was loaded with { auth: true }.
function fromStaff(staff, account = null) {
  return {
    id: staff.id,
    kind: 'staff',
    username: staff.username,
    display_name: staff.display_name,
    avatar_url: staff.avatar_url ?? null,
    is_admin: staff.is_admin === true,
    is_editor: staff.is_editor === true,
    is_approved: staff.is_approved === true,
    prefs: prefsOf(account),
    ...('password_hash' in staff ? { password_hash: staff.password_hash, totp_secret: staff.totp_secret ?? null } : {}),
  };
}

function fromPublic(account) {
  return {
    id: account.id,
    kind: 'public',
    username: account.username,
    display_name: account.display_name,
    avatar_url: null,
    is_admin: false,
    is_editor: false,
    is_approved: account.status === 'active',
    prefs: prefsOf(account),
    ...('password_hash' in account ? { password_hash: account.password_hash, totp_secret: null } : {}),
  };
}

function prefsOf(account) {
  return {
    updates: account?.notify_updates !== false,
    reminders: account?.notify_reminders !== false,
    newEvents: account?.notify_new_events === true,
    telegram: account?.notify_telegram === true,
  };
}

// An account row from SESSION_ACCOUNT_SELECT, normalised, or null.
export function normaliseAccount(row) {
  if (!row) return null;
  if (row.kind === 'staff') return row.staff ? fromStaff(row.staff, row) : null;
  if (row.kind === 'public') return fromPublic(row);
  return null;
}

export function canSignIn(account) {
  return Boolean(account && account.is_approved === true);
}

export function canManage(account) {
  return canSignIn(account) && account.kind === 'staff' && (account.is_admin === true || account.is_editor === true);
}

export function isAdmin(account) {
  return canManage(account) && account.is_admin === true;
}

export function roleOf(account) {
  if (isAdmin(account)) return 'admin';
  if (canManage(account)) return 'editor';
  if (account?.kind === 'staff') return 'staff';
  return 'member';
}

// Staff must have a second factor; public accounts choose.
export function secondFactorRequired(account) {
  return account?.kind === 'staff';
}

// The staff record's row in gftvevents_accounts, made the first time it is
// needed. Same id, so nothing else has to be rewritten.
export async function ensureStaffAccount(staffUserId) {
  const { error } = await db()
    .from(T.accounts)
    .upsert({ id: staffUserId, kind: 'staff', staff_user_id: staffUserId }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
}

// A username or an email. Staff are looked up the way gftv-linktree does (two
// exact lookups on lowercased input, never an .or() built from it); public
// accounts the same way. Returns { staff, member }, either of which may be
// null, both with their password hashes, so the caller can check the
// password against each.
export async function findForLogin(identifier) {
  const value = String(identifier ?? '').trim().toLowerCase();
  if (!value || value.length > 254 || /\s/.test(value)) return { staff: null, member: null };
  const column = value.includes('@') ? 'email' : 'username';
  const [staff, member] = await Promise.all([
    db().from(T.users).select(STAFF_AUTH_COLUMNS).eq(column, value).maybeSingle(),
    db().from(T.accounts).select(ACCOUNT_AUTH_COLUMNS).eq('kind', 'public').eq(column, value).maybeSingle(),
  ]);
  if (staff.error) throw staff.error;
  if (member.error) throw member.error;
  return {
    staff: staff.data ? fromStaff(staff.data) : null,
    member: member.data ? fromPublic(member.data) : null,
  };
}

// An account by id, normalised. { auth: true } adds the password hash and the
// shared TOTP secret, for the routes that check them.
export async function loadAccount(id, { auth = false } = {}) {
  const { data, error } = await db()
    .from(T.accounts)
    .select(auth ? ACCOUNT_AUTH_COLUMNS + ', staff_user_id' : ACCOUNT_COLUMNS + ', staff_user_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // A staff member whose accounts row does not exist yet.
    const { data: staff, error: staffError } = await db()
      .from(T.users)
      .select(auth ? STAFF_AUTH_COLUMNS : STAFF_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (staffError) throw staffError;
    return staff ? fromStaff(staff) : null;
  }
  if (data.kind === 'public') return fromPublic(data);
  const { data: staff, error: staffError } = await db()
    .from(T.users)
    .select(auth ? STAFF_AUTH_COLUMNS : STAFF_COLUMNS)
    .eq('id', data.staff_user_id)
    .maybeSingle();
  if (staffError) throw staffError;
  return staff ? fromStaff(staff, data) : null;
}

// Is this username or email free for a new public account? Checks staff
// accounts too, so nobody can sign up as a staff member's username or email.
export async function identityTaken({ username, email }) {
  const checks = await Promise.all([
    db().from(T.accounts).select('id').eq('username', username).maybeSingle(),
    db().from(T.users).select('id').eq('username', username).maybeSingle(),
    db().from(T.accounts).select('id').eq('email', email).maybeSingle(),
    db().from(T.users).select('id').eq('email', email).maybeSingle(),
  ]);
  for (const c of checks) if (c.error) throw c.error;
  if (checks[0].data || checks[1].data) return 'username_taken';
  if (checks[2].data || checks[3].data) return 'email_taken';
  return null;
}
