// GET /api/cron/notify, run hourly by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sends the day-before reminders and the "new event" notices (notify.js).
// Hourly is the coarsest schedule that still gives roughly a day's notice.

import { route, send } from '../_lib/http.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { sendReminders, announceNewEvents } from '../_lib/notify.js';

// Checks Vercel's cron secret, then sends the reminders and the new-event
// notices, and answers with how many of each went.
export default route('cron/notify', async (request, response) => {
  const secret = optionalEnv('CRON_SECRET');
  let given = '';
  if (request.headers.authorization) {
    given = String(request.headers.authorization);
  }
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) {
    return send(response, 401, { ok: false });
  }

  const reminded = await sendReminders();
  const announced = await announceNewEvents();
  send(response, 200, { ok: true, reminded, announced });
});
