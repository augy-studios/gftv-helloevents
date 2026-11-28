// Email as a backup second step, and as a way to reset a forgotten password
// (migrations/028). Sending is email.js; this is the rest.
//
// An account first confirms its address on the account page (a code or a
// link emailed to it). Only that exact address counts: when the account's
// email changes, the confirmation stops holding. Email never turns 2FA on by
// itself (factors.js hasSecondFactor leaves it out); once 2FA is on, it is
// accepted as the second step, as Telegram is.
//
// Each email carries a six digit code and a link, both on the challenge
// (bcrypt of the code, SHA-256 of the link's token) and both expiring after
// EMAIL_CODE_MINUTES. The code works anywhere. The link works only in the
// browser that asked for the email: that browser holds a random value in an
// HttpOnly cookie, and the challenge its SHA-256 (email_browser_hash). So a
// link opened elsewhere, forwarded, or fetched by a mail scanner does
// nothing; and opening it only shows a page, which then asks with a POST.
// Confirming the address needs no cookie: it needs the signed-in session of
// the same account.

import bcrypt from 'bcryptjs';
import { database, TABLES } from './supabase.js';
import { randomDigits, randomToken, safeEqual, sha256 } from './crypto.js';
import { readCookie, setCookie } from './http.js';
import { siteUrl } from './env.js';
import { updateChallenge, CHALLENGE_COLUMNS, CHALLENGE_ATTEMPTS } from './session.js';
import { emailConfigured, sendEmail, codeEmail } from './email.js';

export const EMAIL_CODE_MINUTES = 10;
const BROWSER_COOKIE = '__Host-ghe_email_browser';
const BROWSER_COOKIE_SECONDS = 30 * 60;
const BROWSER_VALUE = /^[A-Za-z0-9_-]{32,64}$/;

// Where each email's link goes. login and reset carry the token after "#",
// so it never reaches a server log; the account page's own "#" is its tab.
const LINK_PATHS = {
  'sign-in': (token) => `/login#email=${token}`,
  reset: (token) => `/reset#email=${token}`,
  confirm: (token) => `/account?emailConfirm=${token}#security`,
};

// The address the account confirmed, when it is still the account's email;
// otherwise null. account: loaded with its secrets (users.js), for .email.
export async function confirmedEmail(account) {
  if (!account || !account.email) {
    return null;
  }
  const { data, error } = await database().from(TABLES.emailFactors).select('email').eq('user_id', account.id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data || String(data.email).toLowerCase() !== account.email) {
    return null;
  }
  return account.email;
}

// Whether email can be used for this account right now: sending is set up
// and its address is confirmed.
export async function emailUsable(account) {
  if (!emailConfigured()) {
    return false;
  }
  return Boolean(await confirmedEmail(account));
}

export async function saveConfirmedEmail(account) {
  const now = new Date().toISOString();
  const { error } = await database()
    .from(TABLES.emailFactors)
    .upsert({ user_id: account.id, email: account.email, confirmed_at: now }, { onConflict: 'user_id' });
  if (error) {
    throw error;
  }
  if (account.kind === 'public') {
    await database().from(TABLES.accounts).update({ email_verified_at: now }).eq('id', account.id).eq('kind', 'public');
  }
}

export async function removeConfirmedEmail(userId) {
  const { error } = await database().from(TABLES.emailFactors).delete().eq('user_id', userId);
  if (error) {
    throw error;
  }
}

// "otter@example.com" as "o***r@example.com", for the account page, which
// never shows the whole address.
export function maskEmail(address) {
  if (typeof address !== 'string' || !address.includes('@')) {
    return null;
  }
  const at = address.lastIndexOf('@');
  const name = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (name.length <= 2) {
    return `${name.charAt(0)}***@${domain}`;
  }
  return `${name.charAt(0)}***${name.charAt(name.length - 1)}@${domain}`;
}

// This browser's random value, made and set as a cookie if it has none yet
// (a browser with one keeps it, so its sign-in and reset links both work).
function browserValue(request, response) {
  let value = readCookie(request, BROWSER_COOKIE);
  if (typeof value !== 'string' || !BROWSER_VALUE.test(value)) {
    value = randomToken(32);
  }
  setCookie(response, BROWSER_COOKIE, value, BROWSER_COOKIE_SECONDS);
  return value;
}

// Whether this request comes from the browser the challenge's email was
// sent from.
export function sameBrowser(request, challenge) {
  const value = readCookie(request, BROWSER_COOKIE);
  if (typeof value !== 'string' || !BROWSER_VALUE.test(value) || !challenge.email_browser_hash) {
    return false;
  }
  return safeEqual(sha256(value), challenge.email_browser_hash);
}

// Emails a fresh code and link for a challenge, replacing any earlier ones.
// purpose: "sign-in", "reset" or "confirm". Throws when the email could not
// be sent; the caller answers email_send_failed.
export async function sendEmailCode(request, response, challenge, { purpose, account, address }) {
  const code = randomDigits();
  const token = randomToken(32);
  const fields = {
    email_code_hash: await bcrypt.hash(code, 10),
    email_code_expires_at: new Date(Date.now() + EMAIL_CODE_MINUTES * 60_000).toISOString(),
    email_link_hash: sha256(token),
    email_verified_at: null,
  };
  if (purpose !== 'confirm') {
    fields.email_browser_hash = sha256(browserValue(request, response));
  }
  await updateChallenge(challenge, fields);
  const link = `${siteUrl()}${LINK_PATHS[purpose](token)}`;
  await sendEmail({ to: address, ...codeEmail({ purpose, username: account.username, code, link, minutes: EMAIL_CODE_MINUTES, locale: account.locale }) });
}

function emailUnexpired(challenge) {
  if (!challenge.email_code_expires_at) {
    return false;
  }
  return new Date(challenge.email_code_expires_at).getTime() > Date.now();
}

// Whether typed is the challenge's emailed code and it has not expired.
export async function emailCodeOk(challenge, typed) {
  if (!challenge.email_code_hash || !emailUnexpired(challenge)) {
    return false;
  }
  let typedText = '';
  if (typed !== null && typed !== undefined) {
    typedText = String(typed);
  }
  const digits = typedText.replace(/\D/g, '');
  if (digits.length !== 6) {
    return false;
  }
  return bcrypt.compare(digits, challenge.email_code_hash);
}

// A link token as sent back by a page, or null when it cannot be one.
export function linkToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(value)) {
    return null;
  }
  return value;
}

// The live challenge an emailed link belongs to, or null. Out of date,
// out of attempts, or an expired email: null (the row is left for
// findChallenge to clear).
export async function challengeForLink(token, purpose) {
  const link = linkToken(token);
  if (!link) {
    return null;
  }
  const { data, error } = await database()
    .from(TABLES.challenges)
    .select(CHALLENGE_COLUMNS)
    .eq('email_link_hash', sha256(link))
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data || new Date(data.expires_at).getTime() <= Date.now() || data.attempts >= CHALLENGE_ATTEMPTS || !emailUnexpired(data)) {
    return null;
  }
  return data;
}
