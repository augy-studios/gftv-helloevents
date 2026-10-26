// The signed-in person's notifications.
//
// GET                                   -> { prefs, push, telegram }
// POST { action: "prefs", updates?, reminders?, newEvents?, telegram? }
// POST { action: "subscribe", subscription }   this browser, from PushManager
// POST { action: "unsubscribe", endpoint }
// POST { action: "test" }                       a test notice to every device
//
// What each choice sends is described in api/_lib/notify.js.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount } from '../_lib/users.js';
import { linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { pushConfigured, vapidPublicKey, deviceCount, checkSubscription, saveSubscription, removeSubscription } from '../_lib/push.js';
import { deliver } from '../_lib/notify.js';
import { siteUrl } from '../_lib/env.js';

async function summary(user) {
  const account = await loadAccount(user.id);
  const [devices, chat] = await Promise.all([
    pushConfigured() ? deviceCount(user.id) : 0,
    telegramConfigured() ? linkedChat(user.id) : null,
  ]);
  return {
    prefs: account.prefs,
    push: { available: pushConfigured(), publicKey: pushConfigured() ? vapidPublicKey() : null, devices },
    telegram: { available: telegramConfigured(), linked: Boolean(chat) },
  };
}

const COLUMNS = { updates: 'notify_updates', reminders: 'notify_reminders', newEvents: 'notify_new_events', telegram: 'notify_telegram' };

export default route('me/notifications', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const session = await requireUser(req, res);
  if (!session) return;
  const user = session.user;

  if (req.method === 'GET') return ok(res, await summary(user));

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'notifyWrite', [`u:${user.id}`])) return;

  if (body.action === 'prefs') {
    const fields = {};
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (key in body) {
        if (typeof body[key] !== 'boolean') return fail(res, 400, 'bad_request');
        fields[column] = body[key];
      }
    }
    if (Object.keys(fields).length === 0) return fail(res, 400, 'bad_request');
    const { error } = await db().from(T.accounts).update(fields).eq('id', user.id);
    if (error) throw error;
    return ok(res, await summary(user));
  }

  if (body.action === 'subscribe') {
    if (!pushConfigured()) return fail(res, 400, 'push_off');
    const check = checkSubscription(body.subscription);
    if (!check.ok) return fail(res, 400, check.error);
    const saved = await saveSubscription(user.id, check.subscription);
    if (!saved.ok) return fail(res, 409, saved.error);
    await audit(req, { action: 'notify.device_added', actorId: user.id });
    return ok(res, await summary(user));
  }

  if (body.action === 'unsubscribe') {
    if (pushConfigured()) await removeSubscription(user.id, body.endpoint);
    return ok(res, await summary(user));
  }

  if (body.action === 'test') {
    const { prefs } = await loadAccount(user.id);
    const reached = await deliver([{ id: user.id, notify_telegram: prefs.telegram }], {
      heading: 'Test',
      title: 'GFTV HelloEvents',
      lines: ['Notifications work on this device.'],
      url: `${siteUrl()}/account`,
      tag: 'test',
    });
    return ok(res, { reached });
  }

  fail(res, 400, 'bad_request');
});
