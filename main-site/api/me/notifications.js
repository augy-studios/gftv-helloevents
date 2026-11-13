// The signed-in person's notifications.
//
// GET                                   -> { prefs, push, telegram }
// POST { action: "prefs", updates?, reminders?, newEvents?, telegram? }
// POST { action: "subscribe", subscription }   this browser, from PushManager
// POST { action: "unsubscribe", endpoint }
// POST { action: "test" }                       a test notice to every device
//                                               (and the linked chat); no count
//
// prefs, subscribe and unsubscribe answer with the same summary as GET.
// What each choice sends is described in api/_lib/notify.js.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount } from '../_lib/users.js';
import { linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { pushConfigured, vapidPublicKey, deviceCount, checkSubscription, saveSubscription, removeSubscription } from '../_lib/push.js';
import { deliver } from '../_lib/notify.js';
import { siteUrl } from '../_lib/env.js';

// The notification settings the account page shows: the choices, whether
// web push is on (with the key a browser subscribes with, and how many
// devices are subscribed), and whether a Telegram chat is linked.
async function summary(user) {
  const account = await loadAccount(user.id);
  let deviceLookup = 0;
  if (pushConfigured()) {
    deviceLookup = deviceCount(user.id);
  }
  let chatLookup = null;
  if (telegramConfigured()) {
    chatLookup = linkedChat(user.id);
  }
  const [devices, chat] = await Promise.all([deviceLookup, chatLookup]);
  const preferences = account.prefs;
  let publicKey = null;
  if (pushConfigured()) {
    publicKey = vapidPublicKey();
  }
  return {
    prefs: preferences,
    push: { available: pushConfigured(), publicKey, devices },
    telegram: { available: telegramConfigured(), linked: Boolean(chat) },
  };
}

// Each choice in a "prefs" request and the accounts column it is saved in.
const PREFERENCE_COLUMNS = {
  updates: 'notify_updates',
  reminders: 'notify_reminders',
  newEvents: 'notify_new_events',
  telegram: 'notify_telegram',
};

// GET answers with the summary. POST changes the choices, adds or removes
// this browser's push subscription, or sends a test notice.
export default route('me/notifications', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const user = session.user;

  if (request.method === 'GET') {
    return ok(response, await summary(user));
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'notifyWrite', [`u:${user.id}`])) {
    return;
  }

  if (body.action === 'prefs') {
    // Only the choices sent are changed, and each must be true or false.
    const fields = {};
    for (const [key, column] of Object.entries(PREFERENCE_COLUMNS)) {
      if (key in body) {
        if (typeof body[key] !== 'boolean') {
          return fail(response, 400, 'bad_request');
        }
        fields[column] = body[key];
      }
    }
    if (Object.keys(fields).length === 0) {
      return fail(response, 400, 'bad_request');
    }
    const { error } = await database().from(TABLES.accounts).update(fields).eq('id', user.id);
    if (error) {
      throw error;
    }
    return ok(response, await summary(user));
  }

  if (body.action === 'subscribe') {
    if (!pushConfigured()) {
      return fail(response, 400, 'push_off');
    }
    const check = checkSubscription(body.subscription);
    if (!check.ok) {
      return fail(response, 400, check.error);
    }
    const saved = await saveSubscription(user.id, check.subscription);
    if (!saved.ok) {
      return fail(response, 409, saved.error);
    }
    await audit(request, { action: 'notify.device_added', actorId: user.id });
    return ok(response, await summary(user));
  }

  if (body.action === 'unsubscribe') {
    if (pushConfigured()) {
      await removeSubscription(user.id, body.endpoint);
    }
    return ok(response, await summary(user));
  }

  if (body.action === 'test') {
    const account = await loadAccount(user.id);
    const preferences = account.prefs;
    // The notice itself is the answer; the page shows no count.
    await deliver([{ id: user.id, notify_telegram: preferences.telegram }], {
      heading: 'Test',
      title: 'GFTV HelloEvents',
      lines: ['Notifications work on this device.'],
      url: `${siteUrl()}/account`,
      tag: 'test',
    });
    return ok(response);
  }

  fail(response, 400, 'bad_request');
});
