// Redis, for Web Push subscriptions only: Upstash Redis, added to the Vercel
// project through the Marketplace (Vercel KV itself was retired and moved to
// Upstash). The integration sets UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN; stores moved over from Vercel KV carry the older
// KV_REST_API_URL and KV_REST_API_TOKEN, which are accepted too, the same
// fallback @upstash/redis's own Redis.fromEnv() makes.
//
// Without either pair, push notifications are switched off and the account
// page says so; everything else works.

import { Redis } from '@upstash/redis';
import { optionalEnv } from './env.js';

let client = null;

export function useTestRedis(fake) {
  client = fake;
}

// The REST URL and token, each from the Upstash name or else the older
// Vercel KV name, or null when either one is missing.
function credentials() {
  let url = optionalEnv('UPSTASH_REDIS_REST_URL');
  if (!url) {
    url = optionalEnv('KV_REST_API_URL');
  }
  let token = optionalEnv('UPSTASH_REDIS_REST_TOKEN');
  if (!token) {
    token = optionalEnv('KV_REST_API_TOKEN');
  }
  if (url && token) {
    return { url, token };
  }
  return null;
}

export function redisConfigured() {
  if (client !== null || credentials() !== null) {
    return true;
  }
  return false;
}

export function redis() {
  if (!client) {
    const found = credentials();
    if (!found) {
      throw new Error('Redis is not configured (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)');
    }
    // Values are stored as JSON strings and parsed here, not by the client.
    client = new Redis({ ...found, automaticDeserialization: false });
  }
  return client;
}
