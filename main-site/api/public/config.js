// GET /api/public/config -> { turnstileSiteKey, telegram }
//
// What the sign-in, sign-up and reset pages need to draw themselves: the
// Turnstile site key (public by design; the secret never leaves the server),
// or null when the check is skipped (no TURNSTILE_SECRET outside
// production; turnstile.js), and whether the Telegram option exists at all.

import { route, guard, ok } from '../_lib/http.js';
import { turnstileSiteKey } from '../_lib/turnstile.js';
import { telegramConfigured } from '../_lib/telegram.js';

export default route('public/config', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(res, { turnstileSiteKey: turnstileSiteKey(), telegram: telegramConfigured() });
});
