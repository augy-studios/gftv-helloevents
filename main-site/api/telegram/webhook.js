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
// Every reply is in the language of the account the chat is linked to, as
// the site saved it (bot-text.js); for a chat linked to none, the language
// of the person's Telegram app when the site offers it, else English.
//
// Private chats only: a code must never land in a group.
// Always answers 200 once the secret matches, so Telegram does not retry an
// update that was understood and refused.

import { route, readJson, send, errorDetail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { optionalEnv, siteHost } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { audit } from '../_lib/guards.js';
import { sendTelegram, sendRichTelegram, spendLinkToken, saveLink, linkedLocale } from '../_lib/telegram.js';
import { helpMessage } from '../_lib/telegram-messages.js';
import { loadAccount, canSignIn } from '../_lib/users.js';
import { botT, botLocale, localeFromTelegram } from '../_lib/bot-text.js';

// The language to answer a chat in: its linked account's, or the sender's
// Telegram app's (from.language_code). A lookup that fails falls back to
// the app's language, so the reply still goes.
async function chatLanguage(chat, from) {
  let languageCode = '';
  if (from !== null && from !== undefined && typeof from.language_code === 'string') {
    languageCode = from.language_code;
  }
  try {
    const linked = await linkedLocale(chat.id);
    if (linked) {
      return linked;
    }
  } catch (cause) {
    console.warn('[helloevents] telegram language:', errorDetail(cause));
  }
  return localeFromTelegram(languageCode);
}

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
// its account page, while signed in. The reply is in that account's
// language once it is known; locale is the chat's until then.
async function linkChat(chat, linkToken, telegramUsername, reply, locale) {
  const token = await spendLinkToken(linkToken);
  let user = null;
  if (token) {
    user = await loadAccount(token.userId);
  }
  // Tokens made during the old first-time set-up (challengeId set) are no
  // longer issued and are refused like an expired one.
  if (!token || token.challengeId || !user || !canSignIn(user)) {
    await reply(botT(locale, 'bot.link-expired'));
    return;
  }

  // From the account page, by someone already signed in.
  await saveLink(user.id, chat.id, telegramUsername);
  await audit(null, { action: 'security.telegram_linked', actorId: user.id });
  let accountLocale = locale;
  if (user.locale) {
    accountLocale = botLocale(user.locale);
  }
  await reply(botT(accountLocale, 'bot.linked', { username: user.username, site: siteHost() }));
}

// "/unlink": unlinks this chat from every account it is linked to.
// The reply is in the language of the chat (chatLanguage, read before the
// link goes).
async function unlinkChat(chat, reply, locale) {
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
  let answer = botT(locale, 'bot.not-linked');
  if (unlinkedRows.length > 0) {
    answer = botT(locale, 'bot.unlinked');
  }
  await reply(answer);
}

// Checks the secret, answers /chatid in any chat with that chat's id (to
// put in ADMIN_CHAT_IDS or an event's organiser chats, migrations/026),
// ignores anything else but a text message in a private chat, and answers
// /start, /unlink, or anything else with the help message.
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
  if (chat && /^\/chatid(?:@\w+)?$/.test(text) && ['private', 'group', 'supergroup'].includes(chat.type)) {
    // In a group, the language of whoever asked.
    let locale = 'en';
    if (chat.type === 'private') {
      locale = await chatLanguage(chat, message.from);
    } else if (message.from !== null && message.from !== undefined) {
      locale = localeFromTelegram(message.from.language_code);
    }
    await sendTelegram(chat.id, botT(locale, 'bot.chat-id', { id: chat.id }))
      .catch((cause) => console.warn('[helloevents] telegram reply:', errorDetail(cause)));
    return send(response, 200, { ok: true });
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

  const locale = await chatLanguage(chat, message.from);

  const startCommand = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (startCommand && startCommand[1]) {
    await linkChat(chat, startCommand[1], telegramUsername, reply, locale);
    return send(response, 200, { ok: true });
  }

  if (/^\/unlink(?:@\w+)?$/.test(text)) {
    await unlinkChat(chat, reply, locale);
    return send(response, 200, { ok: true });
  }

  await sendRichTelegram(chat.id, helpMessage(locale)).catch((cause) =>
    console.warn('[helloevents] telegram help:', errorDetail(cause))
  );
  send(response, 200, { ok: true });
});
