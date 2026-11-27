// The admins' Telegram chats (ADMIN_CHAT_IDS) and sending to a list of
// chats, kept apart from staff-alerts.js so the ID check modules can tell the
// admins about a verification without importing serialize.js (which imports
// id-checks.js back). staff-alerts.js re-exports these.

import { optionalEnv } from './env.js';
import { botTokenSet, sendRichTelegram, sendTelegram } from './telegram.js';
import { loadAccount } from './users.js';
import { errorDetail } from './http.js';

// A Telegram chat id: a person's (digits) or a group's (a "-" then digits).
const CHAT_ID = /^-?\d{1,20}$/;

// What the admins' notice calls each way of verifying.
const ID_WAY_NAMES = { helloid: 'HelloID', didit: 'Didit', veriff: 'Veriff' };

// The chat ids in a list or in text ("123, -100456 789"): each a valid id,
// once, in order. Anything that is not one is left out.
export function parseChatIds(input) {
  let parts = [];
  if (Array.isArray(input)) {
    parts = input.map((part) => String(part));
  } else if (typeof input === 'string') {
    parts = input.split(/[\s,;]+/);
  }
  const ids = [];
  for (const part of parts) {
    const id = part.trim();
    if (CHAT_ID.test(id) && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

// The admins' chats, from ADMIN_CHAT_IDS.
export function adminChatIds() {
  return parseChatIds(optionalEnv('ADMIN_CHAT_IDS'));
}

// Sends a message to each chat; returns the ids it could not reach. message:
// a rich { markdown, fallback }, or a string sent as plain text.
export async function sendToChats(chatIds, message) {
  const failed = [];
  if (!botTokenSet()) {
    return [...chatIds];
  }
  for (const chatId of chatIds) {
    try {
      if (typeof message === 'string') {
        await sendTelegram(chatId, message);
      } else {
        await sendRichTelegram(chatId, message);
      }
    } catch (cause) {
      failed.push(chatId);
      console.warn('[helloevents] staff alert:', chatId, errorDetail(cause));
    }
  }
  return failed;
}

// The admins' one-line notice of a verification: "otter has HelloID".
export function idVerifiedText(username, way) {
  let wayName = String(way);
  if (ID_WAY_NAMES[way]) {
    wayName = ID_WAY_NAMES[way];
  }
  return `${username} has ${wayName}`;
}

// An account has just passed an ID check with this way (helloid, didit,
// veriff), by the checks themselves or by an admin's review: the admins hear
// of it. Never throws, so a Telegram or lookup failure cannot undo or fail
// the approval it follows.
export async function alertIdVerified(accountId, way) {
  const admins = adminChatIds();
  if (admins.length === 0 || !botTokenSet()) {
    return;
  }
  try {
    const account = await loadAccount(accountId);
    if (!account || !account.username) {
      return;
    }
    await sendToChats(admins, idVerifiedText(account.username, way));
  } catch (cause) {
    console.warn('[helloevents] id verified alert:', errorDetail(cause));
  }
}
