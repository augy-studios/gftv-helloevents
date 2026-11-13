// GET /api/cron/cleanup, run daily by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sweeps what expiry-on-read misses, so the free-tier database stays small:
// expired sessions, challenges, WebAuthn ceremonies, Telegram link tokens,
// admin reset codes, sign-up allowances and rate limit buckets, and audit
// entries older than AUDIT_DAYS.

import { route, send, errorDetail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';

const AUDIT_DAYS = 365;
const RATE_BUCKET_HOURS = 24;

// Checks Vercel's cron secret, then runs each sweep in turn and answers with
// how many rows each one removed.
export default route('cron/cleanup', async (request, response) => {
  const secret = optionalEnv('CRON_SECRET');
  let given = '';
  if (request.headers.authorization) {
    given = String(request.headers.authorization);
  }
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) {
    return send(response, 401, { ok: false });
  }

  const now = new Date().toISOString();
  const counts = {};
  // Runs one delete and records how many rows it removed under name.
  const sweep = async (name, deleteQuery) => {
    const { count, error } = await deleteQuery;
    if (error) {
      throw error;
    }
    let removed = 0;
    if (count !== null && count !== undefined) {
      removed = count;
    }
    counts[name] = removed;
  };
  // A delete from table that also counts the rows it removes.
  const deleteFrom = (table) => database().from(table).delete({ count: 'exact' });

  await sweep('sessions', deleteFrom(TABLES.sessions).lt('expires_at', now));
  await sweep('challenges', deleteFrom(TABLES.challenges).lt('expires_at', now));
  await sweep('webauthn', deleteFrom(TABLES.webauthn).lt('expires_at', now));
  await sweep('telegramTokens', deleteFrom(TABLES.telegramTokens).lt('expires_at', now));
  const rateCutoff = new Date(Date.now() - RATE_BUCKET_HOURS * 3600_000).toISOString();
  await sweep('rateLimits', deleteFrom(TABLES.rateLimits).lt('window_start', rateCutoff));
  // migrations/003; harmless before it has run (the error is the missing
  // table, which is logged and skipped).
  const laterTables = [
    ['passwordResets', TABLES.passwordResets],
    ['signupAllowances', TABLES.signupAllowances],
  ];
  for (const [name, table] of laterTables) {
    try {
      await sweep(name, deleteFrom(table).lt('expires_at', now));
    } catch (cause) {
      console.warn('[helloevents] cleanup', name, errorDetail(cause));
    }
  }
  const auditCutoff = new Date(Date.now() - AUDIT_DAYS * 86400_000).toISOString();
  await sweep('audit', deleteFrom(TABLES.audit).lt('created_at', auditCutoff));

  send(response, 200, { ok: true, swept: counts });
});
