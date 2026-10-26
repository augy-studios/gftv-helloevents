// Web Push: the browser's own notifications, with VAPID keys and the
// web-push library.
//
// Subscriptions live in Redis (redis.js), one hash per account:
//   ghe:push:<account id>   field = first 32 hex of SHA-256(endpoint)
//                           value = JSON { endpoint, keys: { p256dh, auth }, at }
// At most MAX_DEVICES per account. A subscription the push service reports
// as gone (404 or 410) is deleted on sight.
//
// The server sends a request to whatever endpoint a subscription names, so
// the endpoint is checked against the push services browsers actually use.
// Anything else is refused: otherwise a crafted subscription could make the
// server send requests to any address (SSRF).

import webpush from 'web-push';
import { optionalEnv } from './env.js';
import { sha256 } from './crypto.js';
import { redis, redisConfigured } from './redis.js';

export const MAX_DEVICES = 10;
const PREFIX = 'ghe:push:';

// The push services of Chrome and Edge (FCM), Firefox, Safari and Windows.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

let sender = null;

// Tests replace the network call.
export function useTestPushSender(fn) {
  sender = fn;
}

export function vapidPublicKey() {
  return optionalEnv('VAPID_PUBLIC_KEY') || null;
}

export function pushConfigured() {
  return Boolean(vapidPublicKey() && optionalEnv('VAPID_PRIVATE_KEY') && redisConfigured());
}

// { ok: true, subscription } with only the fields web-push needs, or
// { ok: false, error }.
export function checkSubscription(input) {
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint : '';
  const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh : '';
  const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth : '';
  if (endpoint.length === 0 || endpoint.length > 1000) return { ok: false, error: 'push_invalid' };
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: 'push_invalid' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return { ok: false, error: 'push_invalid' };
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return { ok: false, error: 'push_service_unknown' };
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return { ok: false, error: 'push_invalid' };
  return { ok: true, subscription: { endpoint: url.href, keys: { p256dh, auth } } };
}

const fieldOf = (endpoint) => sha256(endpoint).slice(0, 32);

function parse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function deviceCount(accountId) {
  if (!redisConfigured()) return 0;
  return Number(await redis().hlen(PREFIX + accountId)) || 0;
}

// { ok: true } or { ok: false, error: "push_too_many" }.
export async function saveSubscription(accountId, subscription) {
  const key = PREFIX + accountId;
  const field = fieldOf(subscription.endpoint);
  const existing = parse(await redis().hget(key, field));
  if (!existing && (await deviceCount(accountId)) >= MAX_DEVICES) return { ok: false, error: 'push_too_many' };
  await redis().hset(key, { [field]: JSON.stringify({ ...subscription, at: new Date().toISOString() }) });
  return { ok: true };
}

export async function removeSubscription(accountId, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return;
  await redis().hdel(PREFIX + accountId, fieldOf(endpoint));
}

export async function forgetAllSubscriptions(accountId) {
  if (!redisConfigured()) return;
  await redis().del(PREFIX + accountId);
}

async function subscriptionsOf(accountId) {
  const all = (await redis().hgetall(PREFIX + accountId)) ?? {};
  return Object.entries(all)
    .map(([field, value]) => ({ field, sub: parse(value) }))
    .filter((entry) => entry.sub && checkSubscription(entry.sub).ok);
}

// Send one notification to every device of one account. payload:
// { title, body, url, tag }. Returns how many devices took it.
export async function pushToAccount(accountId, payload) {
  if (!pushConfigured()) return 0;
  const entries = await subscriptionsOf(accountId);
  const body = JSON.stringify(payload);
  const options = {
    TTL: 24 * 3600,
    urgency: 'normal',
    vapidDetails: {
      subject: optionalEnv('VAPID_SUBJECT', 'https://events.globalfurry.tv'),
      publicKey: vapidPublicKey(),
      privateKey: optionalEnv('VAPID_PRIVATE_KEY'),
    },
  };
  let delivered = 0;
  for (const { field, sub } of entries) {
    try {
      await (sender ?? webpush.sendNotification)(sub, body, options);
      delivered += 1;
    } catch (cause) {
      const status = cause?.statusCode;
      if (status === 404 || status === 410) await redis().hdel(PREFIX + accountId, field);
      else console.warn('[helloevents] push failed:', status ?? cause?.message ?? cause);
    }
  }
  return delivered;
}
