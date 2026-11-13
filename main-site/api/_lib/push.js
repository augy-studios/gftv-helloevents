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
const KEY_PREFIX = 'ghe:push:';

// The push services of Chrome and Edge (FCM), Firefox, Safari and Windows.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

let sender = null;

// Tests replace the network call.
export function useTestPushSender(testSender) {
  sender = testSender;
}

// The test's stand-in when there is one, otherwise web-push itself.
function pushSender() {
  if (sender !== null && sender !== undefined) {
    return sender;
  }
  return webpush.sendNotification;
}

export function vapidPublicKey() {
  const publicKey = optionalEnv('VAPID_PUBLIC_KEY');
  if (publicKey) {
    return publicKey;
  }
  return null;
}

export function pushConfigured() {
  if (vapidPublicKey() && optionalEnv('VAPID_PRIVATE_KEY') && redisConfigured()) {
    return true;
  }
  return false;
}

// Checks a subscription the browser sent, and keeps only the fields web-push
// needs: { ok: true, subscription }, or { ok: false, error }. The endpoint
// must be plain https on one of PUSH_HOSTS, and the keys must have the
// shape and length browsers make.
export function checkSubscription(input) {
  // input is whatever the browser sent, so any level of it may be missing.
  let endpoint = '';
  let p256dh = '';
  let authSecret = '';
  if (input !== null && input !== undefined) {
    if (typeof input.endpoint === 'string') {
      endpoint = input.endpoint;
    }
    const keys = input.keys;
    if (keys !== null && keys !== undefined) {
      if (typeof keys.p256dh === 'string') {
        p256dh = keys.p256dh;
      }
      if (typeof keys.auth === 'string') {
        authSecret = keys.auth;
      }
    }
  }
  if (endpoint.length === 0 || endpoint.length > 1000) {
    return { ok: false, error: 'push_invalid' };
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: 'push_invalid' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { ok: false, error: 'push_invalid' };
  }
  if (!PUSH_HOSTS.some((pattern) => pattern.test(url.hostname))) {
    return { ok: false, error: 'push_service_unknown' };
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(authSecret)) {
    return { ok: false, error: 'push_invalid' };
  }
  return { ok: true, subscription: { endpoint: url.href, keys: { p256dh, auth: authSecret } } };
}

const fieldOf = (endpoint) => sha256(endpoint).slice(0, 32);

// A stored subscription, parsed, or null when it is missing or unreadable.
function parseStoredValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function deviceCount(accountId) {
  if (!redisConfigured()) {
    return 0;
  }
  const count = Number(await redis().hlen(KEY_PREFIX + accountId));
  if (count) {
    return count;
  }
  return 0;
}

// { ok: true } or { ok: false, error: "push_too_many" }. A device already
// subscribed is updated in place, and never counts against the limit.
export async function saveSubscription(accountId, subscription) {
  const key = KEY_PREFIX + accountId;
  const field = fieldOf(subscription.endpoint);
  const existing = parseStoredValue(await redis().hget(key, field));
  if (!existing) {
    const count = await deviceCount(accountId);
    if (count >= MAX_DEVICES) {
      return { ok: false, error: 'push_too_many' };
    }
  }
  const stored = JSON.stringify({ ...subscription, at: new Date().toISOString() });
  await redis().hset(key, { [field]: stored });
  return { ok: true };
}

export async function removeSubscription(accountId, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) {
    return;
  }
  await redis().hdel(KEY_PREFIX + accountId, fieldOf(endpoint));
}

export async function forgetAllSubscriptions(accountId) {
  if (!redisConfigured()) {
    return;
  }
  await redis().del(KEY_PREFIX + accountId);
}

// Every usable subscription of one account, as [{ field, subscription }].
// Anything unreadable, or that would not pass checkSubscription today, is
// left out.
async function subscriptionsOf(accountId) {
  let stored = await redis().hgetall(KEY_PREFIX + accountId);
  if (stored === null || stored === undefined) {
    stored = {};
  }
  const entries = [];
  for (const [field, value] of Object.entries(stored)) {
    const subscription = parseStoredValue(value);
    if (subscription && checkSubscription(subscription).ok) {
      entries.push({ field, subscription });
    }
  }
  return entries;
}

// Send one notification to every device of one account. payload:
// { title, body, url, tag }. Returns how many devices took it. A device the
// push service says is gone (404 or 410) is forgotten; any other failure is
// logged and the rest still go out.
export async function pushToAccount(accountId, payload) {
  if (!pushConfigured()) {
    return 0;
  }
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
  for (const { field, subscription } of entries) {
    try {
      const send = pushSender();
      await send(subscription, body, options);
      delivered += 1;
    } catch (cause) {
      let status;
      if (cause !== null && cause !== undefined) {
        status = cause.statusCode;
      }
      if (status === 404 || status === 410) {
        await redis().hdel(KEY_PREFIX + accountId, field);
      } else {
        // The status when there is one, else the error's message, else the
        // error itself.
        let detail = status;
        if (detail === null || detail === undefined) {
          if (cause !== null && cause !== undefined) {
            detail = cause.message;
          }
        }
        if (detail === null || detail === undefined) {
          detail = cause;
        }
        console.warn('[helloevents] push failed:', detail);
      }
    }
  }
  return delivered;
}
