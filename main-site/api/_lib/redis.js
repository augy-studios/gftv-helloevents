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

function credentials() {
  const url = optionalEnv('UPSTASH_REDIS_REST_URL') || optionalEnv('KV_REST_API_URL');
  const token = optionalEnv('UPSTASH_REDIS_REST_TOKEN') || optionalEnv('KV_REST_API_TOKEN');
  return url && token ? { url, token } : null;
}

export function redisConfigured() {
  return client !== null || credentials() !== null;
}

export function redis() {
  if (!client) {
    const creds = credentials();
    if (!creds) throw new Error('Redis is not configured (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)');
    // Values are stored as JSON strings and parsed here, not by the client.
    client = new Redis({ ...creds, automaticDeserialization: false });
  }
  return client;
}
