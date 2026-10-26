// Rate limits and the audit log. Small, and used by almost every route.
// Same mechanism as gftv-linktree: one atomic counter per bucket in
// Postgres, shared by every function instance.

import { db, T } from './supabase.js';
import { fail, clientIp } from './http.js';
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
export async function limited(req, res, name, subjects = []) {
  const [max, windowSeconds] = LIMITS[name];
  const keys = [`${name}:ip:${hashIp(clientIp(req))}`, ...subjects.map((s) => `${name}:${s}`)];
  try {
    for (const bucket of keys) {
      const { data, error } = await db().rpc('gftvevents_rate_hit', {
        p_bucket: bucket,
        p_window_seconds: windowSeconds,
      });
      if (error) throw error;
      if (Number(data) > max) {
        res.setHeader('Retry-After', String(windowSeconds));
        fail(res, 429, 'rate_limited');
        return true;
      }
    }
  } catch (cause) {
    console.error('[helloevents] rate limiter:', cause?.message ?? cause);
  }
  return false;
}

// One row per security-relevant event. Details never carry a secret, a code,
// a password or a full address. A failed insert is logged, never thrown, so
// the audit log cannot take a sign-in down with it.
export async function audit(req, { action, actorId = null, eventId = null, details = {} }) {
  const row = {
    action,
    actor_id: actorId,
    event_id: eventId,
    details,
    ip_hash: req ? hashIp(clientIp(req)) : null,
  };
  const { error } = await db().from(T.audit).insert(row);
  if (error) console.error('[helloevents] audit insert:', action, error.message);
}
