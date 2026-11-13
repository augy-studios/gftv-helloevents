// POST /api/telegram/webhook, called by Telegram for every bot update.
//
// Telegram proves the call is genuine by echoing the secret_token given to
// setWebhook in the X-Telegram-Bot-Api-Secret-Token header. That shared
// secret is compared in constant time before anything else is read; there is
// no request signing.
//
//   /start <token>   from the account page of someone signed in: link this
//                    chat to that account (sign-in codes, password reset
//                    codes, and event notices if they switch those on)
//   /unlink          unlink this chat from every account it is linked to
//   anything else    the help message, as a rich message
//
// Private chats only: a code must never land in a group.
// Always answers 200 once the secret matches, so Telegram does not retry an
// update that was understood and refused.

import { route, readJson, send, errorDetail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { optionalEnv, siteHost } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { audit } from '../_lib/guards.js';
import { sendTelegram, sendRichTelegram, spendLinkToken, saveLink } from '../_lib/telegram.js';
import { helpMessage } from '../_lib/telegram-messages.js';
import { loadAccount, canSignIn } from '../_lib/users.js';

// Whether the call really comes from Telegram: the secret token header must
// match TELEGRAM_WEBHOOK_SECRET. Answers 401 (and logs why) when it does not.
function refusedSecret(request, response) {
  const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
  let given = '';
  if (request.headers['x-telegram-bot-api-secret-token']) {
    given = String(request.headers['x-telegram-bot-api-secret-token']);
  }
  if (!secret) {
    console.warn('[helloevents] telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set; refusing the update');
    send(response, 401, { ok: false });
    return true;
  }
  if (!safeEqual(given, secret)) {
    let problem = 'missing';
    if (given) {
      problem = 'does not match';
    }
    console.warn(`[helloevents] telegram webhook: secret token ${problem}; check setWebhook's secret_token`);
    send(response, 401, { ok: false });
    return true;
  }
  return false;
}

// "/start <token>": links this chat to the account that made the token on
// its account page, while signed in.
async function linkChat(chat, linkToken, telegramUsername, reply) {
  const token = await spendLinkToken(linkToken);
  let user = null;
  if (token) {
    user = await loadAccount(token.userId);
  }
  // Tokens made during the old first-time set-up (challengeId set) are no
  // longer issued and are refused like an expired one.
  if (!token || token.challengeId || !user || !canSignIn(user)) {
    await reply('That link has expired or was already used. Make a new one from your account page.');
    return;
  }

  // From the account page, by someone already signed in.
  await saveLink(user.id, chat.id, telegramUsername);
  await audit(null, { action: 'security.telegram_linked', actorId: user.id });
  await reply(
    `Linked to the account ${user.username} on ${siteHost()}. Sign-in codes will arrive here, and event notices if you switch them on in your account.`
  );
}

// "/unlink": unlinks this chat from every account it is linked to.
async function unlinkChat(chat, reply) {
  const { data, error } = await database().from(TABLES.telegram).delete().eq('chat_id', chat.id).select('user_id');
  if (error) {
    throw error;
  }
  let unlinkedRows = [];
  if (data !== null && data !== undefined) {
    unlinkedRows = data;
  }
  for (const row of unlinkedRows) {
    await audit(null, { action: 'security.telegram_unlinked', actorId: row.user_id, details: { via: 'bot' } });
  }
  let answer = 'This chat is not linked to any account.';
  if (unlinkedRows.length > 0) {
    answer = 'Unlinked. This chat will not receive codes any more.';
  }
  await reply(answer);
}

// Checks the secret, ignores anything but a text message in a private chat,
// and answers /start, /unlink, or anything else with the help message.
export default route('telegram/webhook', async (request, response) => {
  if (request.method !== 'POST') {
    return send(response, 405, { ok: false });
  }
  if (refusedSecret(request, response)) {
    return;
  }

  const update = await readJson(request, response);
  if (!update) {
    return;
  }
  const message = update.message;
  let chat;
  let text = '';
  if (message !== null && message !== undefined) {
    chat = message.chat;
    if (typeof message.text === 'string') {
      text = message.text.trim();
    }
  }
  if (!chat || chat.type !== 'private' || !text) {
    return send(response, 200, { ok: true });
  }

  // A reply to this chat. One that fails is logged, never thrown.
  const reply = (replyText) =>
    sendTelegram(chat.id, replyText).catch((cause) => console.warn('[helloevents] telegram reply:', errorDetail(cause)));
  let telegramUsername = null;
  if (message.from !== null && message.from !== undefined && typeof message.from.username === 'string') {
    telegramUsername = message.from.username.slice(0, 64);
  }

  const startCommand = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (startCommand && startCommand[1]) {
    await linkChat(chat, startCommand[1], telegramUsername, reply);
    return send(response, 200, { ok: true });
  }

  if (/^\/unlink(?:@\w+)?$/.test(text)) {
    await unlinkChat(chat, reply);
    return send(response, 200, { ok: true });
  }

  await sendRichTelegram(chat.id, helpMessage()).catch((cause) =>
    console.warn('[helloevents] telegram help:', errorDetail(cause))
  );
  send(response, 200, { ok: true });
});
