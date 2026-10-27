// GET /api/cron/notify, run hourly by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sends the day-before reminders and the "new event" notices (notify.js).
// Hourly is the coarsest schedule that still gives roughly a day's notice.

import { route, send } from '../_lib/http.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { sendReminders, announceNewEvents } from '../_lib/notify.js';

export default route('cron/notify', async (req, res) => {
  const secret = optionalEnv('CRON_SECRET');
  const given = String(req.headers.authorization || '');
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) return send(res, 401, { ok: false });

  const reminded = await sendReminders();
  const announced = await announceNewEvents();
  send(res, 200, { ok: true, reminded, announced });
});
