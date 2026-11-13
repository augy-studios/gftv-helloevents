// GET /api/cron/cleanup, run daily by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sweeps what expiry-on-read misses, so the free-tier database stays small:
// expired sessions, challenges, WebAuthn ceremonies, Telegram link tokens,
// admin reset codes, sign-up allowances and rate limit buckets, and audit
// entries older than AUDIT_DAYS.

import { route, send } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';

const AUDIT_DAYS = 365;
const RATE_BUCKET_HOURS = 24;

export default route('cron/cleanup', async (request, response) => {
  const secret = optionalEnv('CRON_SECRET');
  const given = String(request.headers.authorization || '');
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) return send(response, 401, { ok: false });

  const now = new Date().toISOString();
  const counts = {};
  const sweep = async (name, q) => {
    const { count, error } = await q;
    if (error) throw error;
    counts[name] = count ?? 0;
  };
  const del = (table) => database().from(table).delete({ count: 'exact' });

  await sweep('sessions', del(TABLES.sessions).lt('expires_at', now));
  await sweep('challenges', del(TABLES.challenges).lt('expires_at', now));
  await sweep('webauthn', del(TABLES.webauthn).lt('expires_at', now));
  await sweep('telegramTokens', del(TABLES.telegramTokens).lt('expires_at', now));
  await sweep(
    'rateLimits',
    del(TABLES.rateLimits).lt('window_start', new Date(Date.now() - RATE_BUCKET_HOURS * 3600_000).toISOString())
  );
  // migrations/003; harmless before it has run (the error is the missing
  // table, which is logged and skipped).
  for (const [name, table] of [['passwordResets', TABLES.passwordResets], ['signupAllowances', TABLES.signupAllowances]]) {
    try {
      await sweep(name, del(table).lt('expires_at', now));
    } catch (cause) {
      console.warn('[helloevents] cleanup', name, cause?.message ?? cause);
    }
  }
  await sweep('audit', del(TABLES.audit).lt('created_at', new Date(Date.now() - AUDIT_DAYS * 86400_000).toISOString()));

  send(response, 200, { ok: true, swept: counts });
});
