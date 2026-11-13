// GET /api/public/config -> { turnstileSiteKey }
//
// What the sign-in, sign-up and reset pages need to draw themselves: the
// Turnstile site key (public by design; the secret never leaves the server),
// or null when the check is skipped (no TURNSTILE_SECRET outside
// production; turnstile.js). Whether Telegram is on comes with the answers
// that use it (account page, sign-in, reset), so it is not repeated here.

import { route, guard, ok } from '../_lib/http.js';
import { turnstileSiteKey } from '../_lib/turnstile.js';

// The same answer for everyone, so the CDN may cache it for a minute.
export default route('public/config', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(response, { turnstileSiteKey: turnstileSiteKey() });
});
