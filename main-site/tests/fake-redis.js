// An in-memory stand-in for the @upstash/redis client: the hash commands the
// push subscription store uses (api/_lib/push.js), with string values.

export function createFakeRedis() {
  const hashes = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    hashes,
    async hset(key, fields) {
      for (const [f, v] of Object.entries(fields)) hash(key).set(f, String(v));
      return Object.keys(fields).length;
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hdel(key, ...fields) {
      let n = 0;
      for (const f of fields) if (hashes.get(key)?.delete(f)) n += 1;
      return n;
    },
    async hlen(key) {
      return hashes.get(key)?.size ?? 0;
    },
    async hgetall(key) {
      const h = hashes.get(key);
      return h && h.size ? Object.fromEntries(h) : null;
    },
    async del(key) {
      return hashes.delete(key) ? 1 : 0;
    },
  };
}
