// GET /api/cron/notify, run every ten minutes by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sends the reminders due (notify.js sendReminders: 1, 2 or 3 hours, a day
// or a week before, as each account picked), the "new event" notices, and
// any change notice an editor's save queued that was never sent (its
// background send stopped early), and the admins' notice of each new event
// left over or reaching its release time (staff-alerts.js). Every ten minutes keeps an hour-before
// reminder within five minutes of the hour.

import { route, send } from '../_lib/http.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { sendReminders, announceNewEvents, flushDueChanges } from '../_lib/notify.js';
import { flushDueAdminEvents } from '../_lib/staff-alerts.js';

// Checks Vercel's cron secret, then sends the reminders, the new-event
// notices and any overdue change notices, and answers with how many of each
// went.
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
  const changed = await flushDueChanges();
  const adminEvents = await flushDueAdminEvents();
  send(response, 200, { ok: true, reminded, announced, changed, adminEvents });
});
