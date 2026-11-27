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
  // Per email address only: sign-ups have no per-connection limit
  // (migrations/027), so a venue sharing one Wi-Fi can all sign up.
  signup: [5, 3600],
  recover: [5, 3600],
  notifyWrite: [30, 900],
  cover: [30, 3600],
  // Gallery uploads (migrations/019): a whole set of pictures at once.
  gallery: [300, 3600],
  // Adding and removing sticker packs (migrations/020); an import fetches a
  // whole pack from Telegram. Stills are the full-size first frames of video
  // stickers the browser sends after an import, one per sticker.
  stickers: [20, 3600],
  stickerStill: [1000, 3600],
  // Payment reports and QR code uploads (migrations/016): each can carry a
  // picture.
  payment: [20, 3600],
  // Google Maps links read for the edit form (api/manage/place.js), kept
  // well inside Nominatim's one request a second.
  placeLookup: [30, 600],
  // ID checks (migrations/027): starting one costs the site a check at
  // the provider, so few an hour per account; coming back from a provider
  // and its webhooks, per connection and per check.
  idCheck: [6, 3600],
  idCheckRead: [60, 600],
  idWebhook: [300, 60],
  // Check-in (migrations/027): organisers scanning at the door, and people
  // checking themselves in at the beacon.
  checkin: [300, 60],
  selfCheckin: [20, 600],
});

// Count one hit for each subject and answer 429 if any is over. Returns true
// when the request has been answered. A failure of the limiter itself lets
// the request through, so a database hiccup does not lock everybody out.
// { perConnection: false } leaves out the connection's own bucket, so only
// the subjects count (sign-up, migrations/027: a con crowd on one Wi-Fi).
export async function limited(request, response, name, subjects = [], { perConnection = true } = {}) {
  const [allowedHits, windowSeconds] = LIMITS[name];
  const buckets = subjects.map((subject) => `${name}:${subject}`);
  if (perConnection) {
    buckets.unshift(`${name}:ip:${hashIp(clientIp(request))}`);
  }
  try {
    for (const bucket of buckets) {
      const { data: hits, error } = await database().rpc('gftvevents_rate_hit', {
        p_bucket: bucket,
        p_window_seconds: windowSeconds,
      });
      if (error) {
        throw error;
      }
      if (Number(hits) > allowedHits) {
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
