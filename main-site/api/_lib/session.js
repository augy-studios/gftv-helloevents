// Sessions on this site, and the challenge rows between the password and the
// second factor.
//
// A session is an HttpOnly cookie holding 32 random bytes; the table holds
// only their SHA-256, so a leaked table is not a set of working cookies. A
// session row is only ever written after a second factor has been checked
// (or set up for the first time): there is no code path that issues one on
// the password alone.
//
// Sessions live in gftvevents_sessions, so signing in or out here never
// touches a session on gftv.asia, links.gftv.asia or any other GFTV site.

import { db, T } from './supabase.js';
import { randomToken, sha256, hashIp } from './crypto.js';
import { readCookie, setCookie, clearCookie, fail, clientIp } from './http.js';
import { USER_COLUMNS, canSignIn, canManage, isAdmin } from './users.js';

export const SESSION_COOKIE = '__Host-ghe_session';
const SESSION_DAYS = 7;
const FACTORS = new Set(['totp', 'passkey', 'telegram', 'backup']);

export async function createSession(req, res, userId, factor) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const { error } = await db().from(T.sessions).insert({
    user_id: userId,
    token_hash: sha256(token),
    factor: FACTORS.has(factor) ? factor : 'totp',
    ip_hash: hashIp(clientIp(req)),
    expires_at: expires.toISOString(),
  });
  if (error) throw error;
  setCookie(res, SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

// { sessionId, user } for a live session of an approved account, or null.
export async function currentSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;

  const { data, error } = await db()
    .from(T.sessions)
    .select(`id, expires_at, last_seen_at, user:${T.users} ( ${USER_COLUMNS} )`)
    .eq('token_hash', sha256(token))
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.user) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await db().from(T.sessions).delete().eq('id', data.id);
    return null;
  }
  // Approval is re-checked on every request, so revoking it on gftv.asia
  // takes effect here on the next click rather than at the next sign in.
  if (!canSignIn(data.user)) return null;
  // Touch at most every ten minutes, to keep writes off the hot path.
  if (Date.now() - new Date(data.last_seen_at).getTime() > 600_000) {
    await db().from(T.sessions).update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
  }
  return { sessionId: data.id, user: data.user };
}

// The signed-in user, or null after answering 401/403.
//   manage: editors and admins only.   admin: admins only.
export async function requireUser(req, res, { manage = false, admin = false } = {}) {
  const session = await currentSession(req);
  if (!session) {
    fail(res, 401, 'signed_out');
    return null;
  }
  if (admin && !isAdmin(session.user)) {
    fail(res, 403, 'admin_only');
    return null;
  }
  if (manage && !canManage(session.user)) {
    fail(res, 403, 'manage_only');
    return null;
  }
  return session;
}

export async function endSession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await db().from(T.sessions).delete().eq('token_hash', sha256(token));
  clearCookie(res, SESSION_COOKIE);
}

export async function endOtherSessions(userId, exceptSessionId) {
  let q = db().from(T.sessions).delete().eq('user_id', userId);
  if (exceptSessionId) q = q.neq('id', exceptSessionId);
  const { error } = await q;
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Challenges
//
//   login  the password is right and the account has a second factor; the
//          next request must prove it.
//   enrol  the password is right and the account has no second factor yet;
//          the next requests set one up, and only then is a session issued.
// ---------------------------------------------------------------------------

const CHALLENGE_MINUTES = { login: 10, enrol: 30 };
export const CHALLENGE_ATTEMPTS = 5;

const CHALLENGE_COLUMNS =
  'id, user_id, purpose, attempts, pending_totp_secret, telegram_code_hash, telegram_code_expires_at, ' +
  'pending_telegram_chat_id, pending_telegram_username, expires_at';

export async function createChallenge({ purpose, userId }) {
  // One open challenge per account and purpose: starting again replaces it.
  await db().from(T.challenges).delete().eq('purpose', purpose).eq('user_id', userId);

  const token = randomToken(32);
  const { error } = await db().from(T.challenges).insert({
    purpose,
    user_id: userId,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + CHALLENGE_MINUTES[purpose] * 60_000).toISOString(),
  });
  if (error) throw error;
  return token;
}

// The live challenge row for a token, or null. Expired rows and rows out of
// attempts are deleted on sight.
export async function findChallenge(token, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const { data, error } = await db()
    .from(T.challenges)
    .select(CHALLENGE_COLUMNS)
    .eq('token_hash', sha256(token))
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now() || data.attempts >= CHALLENGE_ATTEMPTS) {
    await db().from(T.challenges).delete().eq('id', data.id);
    return null;
  }
  return data;
}

export async function findChallengeById(id) {
  const { data, error } = await db().from(T.challenges).select(CHALLENGE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data || new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
}

export async function failChallengeAttempt(challenge) {
  await db().from(T.challenges).update({ attempts: challenge.attempts + 1 }).eq('id', challenge.id);
}

export async function updateChallenge(challenge, fields) {
  const { error } = await db().from(T.challenges).update(fields).eq('id', challenge.id);
  if (error) throw error;
}

export async function deleteChallenge(challenge) {
  await db().from(T.challenges).delete().eq('id', challenge.id);
}
