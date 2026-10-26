// POST /api/telegram/webhook, called by Telegram for every bot update.
//
// Telegram proves the call is genuine by echoing the secret_token given to
// setWebhook in the X-Telegram-Bot-Api-Secret-Token header. That shared
// secret is compared in constant time before anything else is read; there is
// no request signing.
//
//   /start <token>   from a set-up page: send a confirmation code to this
//                    chat (the link is made when the code comes back);
//                    from the account page: link this chat straight away
//   /unlink          unlink this chat from every account it is linked to
//   anything else    the help message, as a rich message
//
// Private chats only: a code must never land in a group.
// Always answers 200 once the secret matches, so Telegram does not retry an
// update that was understood and refused.

import { route, readJson, send } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { optionalEnv, siteHost } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { audit } from '../_lib/guards.js';
import { sendTelegram, sendRichTelegram, spendLinkToken, saveLink } from '../_lib/telegram.js';
import { helpMessage } from '../_lib/telegram-messages.js';
import { findChallengeById, updateChallenge } from '../_lib/session.js';
import { sendTelegramCode } from '../_lib/factors.js';
import { findUserById, canSignIn } from '../_lib/users.js';

export default route('telegram/webhook', async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
  const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!secret) {
    console.warn('[helloevents] telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set; refusing the update');
    return send(res, 401, { ok: false });
  }
  if (!safeEqual(given, secret)) {
    console.warn(`[helloevents] telegram webhook: secret token ${given ? 'does not match' : 'missing'}; check setWebhook's secret_token`);
    return send(res, 401, { ok: false });
  }

  const update = await readJson(req, res);
  if (!update) return;
  const message = update.message;
  const chat = message?.chat;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!chat || chat.type !== 'private' || !text) return send(res, 200, { ok: true });

  const reply = (body) =>
    sendTelegram(chat.id, body).catch((cause) => console.warn('[helloevents] telegram reply:', cause?.message ?? cause));
  const username = typeof message.from?.username === 'string' ? message.from.username.slice(0, 64) : null;

  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (start && start[1]) {
    const token = await spendLinkToken(start[1]);
    const user = token ? await findUserById(token.userId) : null;
    if (!token || !user || !canSignIn(user)) {
      await reply('That link has expired or was already used. Make a new one from the page you were on.');
      return send(res, 200, { ok: true });
    }

    if (token.challengeId) {
      // Setting up a first factor: park the chat on the challenge and send a
      // code; the sign-in page links it when the code is typed there.
      const challenge = await findChallengeById(token.challengeId);
      if (!challenge || challenge.purpose !== 'enrol') {
        await reply('That set-up has expired. Sign in again to start over.');
        return send(res, 200, { ok: true });
      }
      await updateChallenge(challenge, { pending_telegram_chat_id: chat.id, pending_telegram_username: username });
      await sendTelegramCode(challenge, chat.id, { purpose: 'confirm', username: user.username });
      return send(res, 200, { ok: true });
    }

    // From the account page, by someone already signed in.
    await saveLink(user.id, chat.id, username);
    await audit(null, { action: 'security.telegram_linked', actorId: user.id });
    await reply(`Linked to the GFTV account ${user.username}. Sign-in codes for ${siteHost()} will arrive here.`);
    return send(res, 200, { ok: true });
  }

  if (/^\/unlink(?:@\w+)?$/.test(text)) {
    const { data, error } = await db().from(T.telegram).delete().eq('chat_id', chat.id).select('user_id');
    if (error) throw error;
    for (const row of data ?? []) {
      await audit(null, { action: 'security.telegram_unlinked', actorId: row.user_id, details: { via: 'bot' } });
    }
    await reply((data ?? []).length > 0 ? 'Unlinked. This chat will not receive codes any more.' : 'This chat is not linked to any account.');
    return send(res, 200, { ok: true });
  }

  await sendRichTelegram(chat.id, helpMessage()).catch((cause) =>
    console.warn('[helloevents] telegram help:', cause?.message ?? cause)
  );
  send(res, 200, { ok: true });
});
