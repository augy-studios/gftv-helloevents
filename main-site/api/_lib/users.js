// Staff accounts: gftvhello_users, owned by gftv.asia and read only here.
//
// Who may sign in: is_approved. Who may create and edit events: is_approved
// and is_admin or is_editor, the same test gftv-linktree uses for its staff
// dashboard. Only admins may delete an event.
//
// Two column lists, and nothing else ever selects from the table:
//   USER_COLUMNS       what a signed-in route may know about the account.
//   USER_AUTH_COLUMNS  adds the secrets, for the sign-in routes only.
// Neither list has email; no route here needs it.

import { db, T } from './supabase.js';

export const USER_COLUMNS = 'id, username, display_name, avatar_url, is_admin, is_editor, is_approved';
export const USER_AUTH_COLUMNS = `${USER_COLUMNS}, password_hash, totp_secret`;

export function canSignIn(user) {
  return Boolean(user && user.is_approved === true);
}

export function canManage(user) {
  return canSignIn(user) && (user.is_admin === true || user.is_editor === true);
}

export function isAdmin(user) {
  return canSignIn(user) && user.is_admin === true;
}

export function roleOf(user) {
  if (isAdmin(user)) return 'admin';
  if (canManage(user)) return 'editor';
  return 'member';
}

// A username or an email address, looked up exactly as gftv-linktree does:
// two exact lookups rather than one .or() filter built from user input.
export async function findUserForLogin(identifier) {
  const value = String(identifier ?? '').trim().toLowerCase();
  if (!value || value.length > 254 || /\s/.test(value)) return null;
  const column = value.includes('@') ? 'email' : 'username';
  const { data, error } = await db().from(T.users).select(USER_AUTH_COLUMNS).eq(column, value).maybeSingle();
  if (error) throw error;
  return data;
}

export async function findUserById(id, columns = USER_COLUMNS) {
  const { data, error } = await db().from(T.users).select(columns).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
