// Telegram Bot API over HTTPS: the bot that sends HelloEvents sign-in codes.
//
// This is a webhook bot (api/telegram/webhook.js). It is a separate bot from
// the OneLink GFTV one, because a bot has exactly one webhook URL.
//
// Linking: the person gets a one-time t.me deep link. Tapping Start sends
// "/start <token>" to the webhook, which ties the chat to the account.
// Codes: the bot sends a six digit code to that chat, which is typed into the
// sign-in page. Private chats only; a code never goes to a group.

import { database, TABLES } from './supabase.js';
import { optionalEnv } from './env.js';
import { randomToken, sha256 } from './crypto.js';

export const LINK_TOKEN_MINUTES = 10;
export const CODE_MINUTES = 5;

// What to log for a failure: its message, or the thrown value itself when
// it has none.
function describeCause(cause) {
  if (cause === null || cause === undefined) {
    return cause;
  }
  const message = cause.message;
  if (message === null || message === undefined) {
    return cause;
  }
  return message;
}

export function telegramConfigured() {
  if (
    optionalEnv('TELEGRAM_BOT_TOKEN') !== '' &&
    optionalEnv('TELEGRAM_BOT_USERNAME') !== '' &&
    optionalEnv('TELEGRAM_WEBHOOK_SECRET') !== ''
  ) {
    return true;
  }
  return false;
}

async function callBot(method, payload) {
  const token = optionalEnv('TELEGRAM_BOT_TOKEN');
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    // The body is Telegram's error description. The bot token is in the URL,
    // never in the body, so it cannot end up in the log.
    const body = await response.text().catch(() => '');
    throw new Error(`telegram ${method} ${response.status}: ${body.slice(0, 200)}`);
  }
}

// Plain text, no parse_mode. For one-line notices ("Linked.", "Unlinked.").
export function sendTelegram(chatId, text) {
  return callBot('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
}

// ---------------------------------------------------------------------------
// Rich Messages, Bot API 10.1 (June 2026), checked against
// https://core.telegram.org/bots/api#sendrichmessage on 26 October 2026:
//
//   sendRichMessage { chat_id, rich_message: InputRichMessage, reply_markup? }
//   InputRichMessage { markdown | html | blocks, media?, is_rtl?,
//                      skip_entity_detection? }
//
// This follows telethon-richmessage-retrofit.md adapted to the HTTP Bot API,
// exactly as gftv-linktree's api/_lib/telegram.js does. That spec targets
// Telethon (MTProto) types; over HTTP the same thing is the sendRichMessage
// method with InputRichMessage.markdown. No parse_mode anywhere.
//
// Every structured message is { markdown, fallback }: Rich Markdown for the
// rich send, and plain text carrying the same information. sendRichMessage
// has no plain text field of its own, so the fallback is sent with
// sendMessage whenever the rich send is refused (an older Bot API server, a
// markup error), and the reason is logged. A rich failure never surfaces as
// an error to the route.
// ---------------------------------------------------------------------------

// Sends rich, as a rich message, or as its plain fallback when Telegram
// refuses the rich one. replyMarkup (buttons), when given, goes with either.
export async function sendRichTelegram(chatId, rich, replyMarkup = null) {
  if (!rich || !rich.fallback) {
    throw new Error('a rich message needs a plain fallback');
  }
  const extra = {};
  if (replyMarkup) {
    extra.reply_markup = replyMarkup;
  }
  try {
    const richMessage = { markdown: rich.markdown };
    // skipEntities: a code message, where a six digit number should not
    // turn into a tappable phone number.
    if (rich.skipEntities) {
      richMessage.skip_entity_detection = true;
    }
    await callBot('sendRichMessage', {
      chat_id: chatId,
      rich_message: richMessage,
      ...extra,
    });
  } catch (error) {
    console.warn(`[helloevents] rich send failed, falling back: ${describeCause(error)}`);
    await callBot('sendMessage', {
      chat_id: chatId,
      text: rich.fallback,
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }
}

// Escape data for Rich Markdown. The spec's set, plus "<" (Rich Markdown
// also accepts HTML tags, so a stray "<" in data could open one) and "$"
// (a pair of them is a formula in Rich Markdown). Literal markup written in
// the builders is not escaped.
const MARKDOWN_SPECIAL = /([\\*_~`|[\]#>=<$])/g;

// escapeMd: escape Markdown. The short name stays because
// tests/unit.test.js calls it by that name.
export function escapeMd(text) {
  return String(text).replace(MARKDOWN_SPECIAL, '\\$1');
}

// For a table cell: also flattens newlines so the row stays one line.
export function escapeCell(text) {
  return escapeMd(String(text).replace(/\r?\n/g, ' '));
}

// The spec's table template: a blank corner cell over the row labels, so each
// row is [label, ...values] for one header per value column.
export function richTable(headers, rows) {
  const lines = [
    `| ${['', ...headers].join(' | ')} |`,
    `| ${Array(headers.length + 1).fill('---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Link tokens
//
// challengeId set: the token was made while setting up a first second factor
// (enrolment), so the webhook does not link the chat directly. It sends a
// confirmation code to the chat and parks the chat id on the challenge; the
// link is made only when that code comes back through the sign-in page.
// challengeId null: a signed-in person linking from their account page; the
// webhook links the chat straight away.
// ---------------------------------------------------------------------------

export async function createLinkToken(userId, challengeId = null) {
  await database().from(TABLES.telegramTokens).delete().eq('user_id', userId).is('used_at', null);
  const token = randomToken(24);
  const { error } = await database().from(TABLES.telegramTokens).insert({
    user_id: userId,
    challenge_id: challengeId,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + LINK_TOKEN_MINUTES * 60_000).toISOString(),
  });
  if (error) {
    throw error;
  }
  return {
    url: `https://t.me/${optionalEnv('TELEGRAM_BOT_USERNAME')}?start=${token}`,
    expiresInMinutes: LINK_TOKEN_MINUTES,
  };
}

// { userId, challengeId } for a live token, spending it, or null.
export async function spendLinkToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    return null;
  }
  const { data, error } = await database()
    .from(TABLES.telegramTokens)
    .update({ used_at: new Date().toISOString() })
    .eq('token_hash', sha256(token))
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id, user_id, challenge_id')
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  return { userId: data.user_id, challengeId: data.challenge_id };
}

// The linked chat: its id (for sending, never sent to a browser) and the
// Telegram handle the account page shows.
export async function linkedChat(userId) {
  const { data, error } = await database()
    .from(TABLES.telegram)
    .select('chat_id, telegram_username')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

export async function saveLink(userId, chatId, username) {
  // A chat with no Telegram username is stored with null.
  let telegramUsername = null;
  if (username) {
    telegramUsername = username;
  }
  const { error } = await database()
    .from(TABLES.telegram)
    .upsert(
      { user_id: userId, chat_id: chatId, telegram_username: telegramUsername, linked_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) {
    throw error;
  }
}
