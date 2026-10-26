// GET /api/cron/cleanup, run daily by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sweeps what expiry-on-read misses, so the free-tier database stays small:
// expired sessions, challenges, WebAuthn ceremonies, Telegram link tokens and
// rate limit buckets, and audit entries older than AUDIT_DAYS.

import { route, send } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';

const AUDIT_DAYS = 365;
const RATE_BUCKET_HOURS = 24;

export default route('cron/cleanup', async (req, res) => {
  const secret = optionalEnv('CRON_SECRET');
  const given = String(req.headers.authorization || '');
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) return send(res, 401, { ok: false });

  const now = new Date().toISOString();
  const counts = {};
  const sweep = async (name, q) => {
    const { count, error } = await q;
    if (error) throw error;
    counts[name] = count ?? 0;
  };
  const del = (table) => db().from(table).delete({ count: 'exact' });

  await sweep('sessions', del(T.sessions).lt('expires_at', now));
  await sweep('challenges', del(T.challenges).lt('expires_at', now));
  await sweep('webauthn', del(T.webauthn).lt('expires_at', now));
  await sweep('telegramTokens', del(T.telegramTokens).lt('expires_at', now));
  await sweep(
    'rateLimits',
    del(T.rateLimits).lt('window_start', new Date(Date.now() - RATE_BUCKET_HOURS * 3600_000).toISOString())
  );
  await sweep('audit', del(T.audit).lt('created_at', new Date(Date.now() - AUDIT_DAYS * 86400_000).toISOString()));

  send(res, 200, { ok: true, swept: counts });
});
