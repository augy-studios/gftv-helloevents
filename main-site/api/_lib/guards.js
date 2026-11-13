// Rate limits and the audit log. Small, and used by almost every route.
// Same mechanism as gftv-linktree: one atomic counter per bucket in
// Postgres, shared by every function instance.

import { database, TABLES } from './supabase.js';
import { fail, clientIp, errorDetail } from './http.js';
import { hashIp } from './crypto.js';

// name: [hits allowed, window in seconds]
export const LIMITS = Object.freeze({
  login: [10, 900],
  secondFactor: [10, 900],
  enrol: [30, 1800],
  telegramSend: [3, 900],
  reauth: [8, 900],
  rsvp: [30, 60],
  manageWrite: [120, 60],
  securityWrite: [30, 900],
  signup: [5, 3600],
  recover: [5, 3600],
  notifyWrite: [30, 900],
  cover: [30, 3600],
});

// Count one hit for each subject and answer 429 if any is over. Returns true
// when the request has been answered. A failure of the limiter itself lets
// the request through, so a database hiccup does not lock everybody out.
// { max } raises the limit on the connection's bucket only (a staff member's
// sign-up allowance); subject buckets keep the normal limit.
export async function limited(request, response, name, subjects = [], { max: connectionLimit = null } = {}) {
  const [allowedHits, windowSeconds] = LIMITS[name];
  const ipBucket = `${name}:ip:${hashIp(clientIp(request))}`;
  const buckets = [ipBucket, ...subjects.map((subject) => `${name}:${subject}`)];
  try {
    for (const bucket of buckets) {
      const { data: hits, error } = await database().rpc('gftvevents_rate_hit', {
        p_bucket: bucket,
        p_window_seconds: windowSeconds,
      });
      if (error) {
        throw error;
      }
      let limit = allowedHits;
      if (bucket === ipBucket && connectionLimit) {
        limit = connectionLimit;
      }
      if (Number(hits) > limit) {
        response.setHeader('Retry-After', String(windowSeconds));
        fail(response, 429, 'rate_limited');
        return true;
      }
    }
  } catch (cause) {
    console.error('[helloevents] rate limiter:', errorDetail(cause));
  }
  return false;
}

// One row per security-relevant event. Details never carry a secret, a code,
// a password or a full address. A failed insert is logged, never thrown, so
// the audit log cannot take a sign-in down with it.
export async function audit(request, { action, actorId = null, eventId = null, details = {} }) {
  let ipHash = null;
  if (request) {
    ipHash = hashIp(clientIp(request));
  }
  const row = {
    action,
    actor_id: actorId,
    event_id: eventId,
    details,
    ip_hash: ipHash,
  };
  const { error } = await database().from(TABLES.audit).insert(row);
  if (error) {
    console.error('[helloevents] audit insert:', action, error.message);
  }
}

// The live sign-up allowance for this request's connection, or null. Staff
// grant one from /manage for the connection they are on ("venue mode",
// migrations/003); it raises the sign-up limit for that connection only,
// until it expires or is revoked. The most generous one wins.
export async function signupAllowance(request) {
  const { data, error } = await database()
    .from(TABLES.signupAllowances)
    .select('id, max_per_hour, expires_at')
    .eq('ip_hash', hashIp(clientIp(request)))
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('max_per_hour', { ascending: false })
    .limit(1);
  if (error) {
    // Before migration 003, or a hiccup: the normal limit applies.
    console.error('[helloevents] sign-up allowance:', error.message);
    return null;
  }
  if (data === null || data === undefined) {
    return null;
  }
  const allowance = data[0];
  if (allowance === null || allowance === undefined) {
    return null;
  }
  return allowance;
}
