// Second factors. Which ones an account has, checking each one, backup codes,
// and Telegram codes.
//
// What counts as a second factor here:
//   totp      for staff, the authenticator app set up on gftv.asia
//             (gftvhello_users.totp_secret, plain base32, read the same way
//             gftv-linktree reads it); for anyone, one set up on this site
//             (gftvevents_totp_secrets, AES-256-GCM encrypted).
//   passkey   a passkey registered on this site.
//   telegram  a Telegram chat linked on this site, when the bot is set up.
//   backup    a one-time backup code: for staff, a shared one from
//             gftvhello_backup_codes (either format other GFTV sites write);
//             for anyone, one issued here. A
//             backup code gets past the second step only, never the password,
//             and on its own it does not count as having a second factor.
//
// This site never writes a secret into gftvhello_users. Staff must already
// have a factor to get in (from gftv.asia, as on OneLink GFTV) and can add
// passkeys and Telegram here afterwards. Public accounts may add any of them
// from the account page; for them 2FA is optional.

import bcrypt from 'bcryptjs';
import { db, T } from './supabase.js';
import {
  decryptSecret,
  encryptSecret,
  findMatchingCode,
  generateBackupCodes,
  hashCode,
  normaliseCode,
  randomDigits,
  safeEqual,
  sha256,
} from './crypto.js';
import { verifyTotp } from './totp.js';
import { countPasskeys } from './webauthn.js';
import { linkedChat, sendRichTelegram, telegramConfigured, CODE_MINUTES } from './telegram.js';
import { codeMessage } from './telegram-messages.js';
import { updateChallenge } from './session.js';

async function eventsTotpSecret(userId) {
  const { data, error } = await db().from(T.totp).select('secret_enc').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data ? decryptSecret(data.secret_enc) : null;
}

export async function hasLocalTotp(userId) {
  const { data, error } = await db().from(T.totp).select('user_id').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function saveEventsTotp(userId, plainSecret) {
  const { error } = await db()
    .from(T.totp)
    .upsert({ user_id: userId, secret_enc: encryptSecret(plainSecret), created_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function totpOk(user, code) {
  if (user.totp_secret && verifyTotp(code, user.totp_secret)) return true;
  const local = await eventsTotpSecret(user.id);
  return Boolean(local) && verifyTotp(code, local);
}

async function sharedBackupCount(account) {
  if (account.kind !== 'staff') return 0;
  const userId = account.id;
  const { count, error } = await db()
    .from(T.sharedBackupCodes)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  return count ?? 0;
}

export async function localBackupCount(userId) {
  const { count, error } = await db()
    .from(T.backupCodes)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('used', false);
  if (error) throw error;
  return count ?? 0;
}

// { totp, passkey, telegram, backup } for the sign-in page. user is a
// normalised account loaded with { auth: true }, since the shared secret is
// part of it.
export async function methodsFor(user) {
  const [local, passkeys, chat, shared, own] = await Promise.all([
    user.totp_secret ? true : hasLocalTotp(user.id),
    countPasskeys(user.id),
    telegramConfigured() ? linkedChat(user.id) : Promise.resolve(null),
    sharedBackupCount(user),
    localBackupCount(user.id),
  ]);
  return {
    totp: Boolean(user.totp_secret) || local === true,
    passkey: passkeys > 0,
    telegram: Boolean(chat),
    backup: shared + own > 0,
  };
}

// Whether 2FA is on. For staff, any of the three. For a public account only
// an authenticator or a passkey switches it on: a linked Telegram chat is
// also how notices and password resets arrive, and linking it for those
// should not start demanding a code at every sign-in. Once 2FA is on,
// Telegram is accepted as the second step too.
export function hasSecondFactor(methods, account = null) {
  if (account?.kind === 'public') return Boolean(methods.totp || methods.passkey);
  return Boolean(methods.totp || methods.passkey || methods.telegram);
}

// Spend one backup code, this site's first, then the shared ones. True if one
// matched. Shared codes come in two formats depending on which GFTV site
// issued them: bcrypt of the lowercased code (careers-gftv), or SHA-256 of
// the uppercased code with its hyphen removed (gftv-redirects-portal). The
// matching shared row is deleted, as every GFTV site does.
// account: a normalised account; only staff have shared codes.
export async function spendBackupCode(account, typed) {
  const userId = account.id;
  if (normaliseCode(typed).length < 6) return false;

  const { data: own, error } = await db()
    .from(T.backupCodes)
    .select('id, code_hash')
    .eq('user_id', userId)
    .eq('used', false);
  if (error) throw error;
  const match = await findMatchingCode(typed, own ?? []);
  if (match) {
    // Conditional on used = false, so two requests racing the same code
    // cannot both succeed.
    const { data: spent, error: spendError } = await db()
      .from(T.backupCodes)
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('id', match.id)
      .eq('used', false)
      .select('id');
    if (spendError) throw spendError;
    return (spent ?? []).length === 1;
  }

  if (account.kind !== 'staff') return false;
  const { data: shared, error: sharedError } = await db()
    .from(T.sharedBackupCodes)
    .select('id, code_hash')
    .eq('user_id', userId);
  if (sharedError) throw sharedError;
  const lower = normaliseCode(typed);
  const legacy = sha256(String(typed).trim().toUpperCase().replace(/\s/g, '').replace('-', ''));
  let matched = null;
  for (const row of shared ?? []) {
    const hash = String(row.code_hash || '');
    const isMatch = hash.startsWith('$2') ? await bcrypt.compare(lower, hash) : safeEqual(hash, legacy);
    if (isMatch && !matched) matched = row;
  }
  if (!matched) return false;
  const { data: gone, error: deleteError } = await db().from(T.sharedBackupCodes).delete().eq('id', matched.id).select('id');
  if (deleteError) throw deleteError;
  return (gone ?? []).length === 1;
}

// A fresh set of ten of this site's codes, replacing any old set. Returns
// the plain codes, which are shown once and never again. Shared codes on
// gftvhello_backup_codes are left alone.
export async function issueBackupCodes(userId) {
  const codes = generateBackupCodes(10);
  const rows = await Promise.all(codes.map(async (code) => ({ user_id: userId, code_hash: await hashCode(code) })));
  const { error: deleteError } = await db().from(T.backupCodes).delete().eq('user_id', userId);
  if (deleteError) throw deleteError;
  const { error } = await db().from(T.backupCodes).insert(rows);
  if (error) throw error;
  return codes;
}

// Send a fresh Telegram code for a challenge, replacing any earlier one.
export async function sendTelegramCode(challenge, chatId, { purpose, username }) {
  const code = randomDigits();
  await updateChallenge(challenge, {
    telegram_code_hash: await bcrypt.hash(code, 10),
    telegram_code_expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
  });
  await sendRichTelegram(chatId, codeMessage({ purpose, username, code, minutes: CODE_MINUTES }));
}

export async function telegramCodeOk(challenge, typed) {
  if (!challenge.telegram_code_hash || !challenge.telegram_code_expires_at) return false;
  if (new Date(challenge.telegram_code_expires_at).getTime() <= Date.now()) return false;
  const digits = String(typed ?? '').replace(/\D/g, '');
  if (digits.length !== 6) return false;
  return bcrypt.compare(digits, challenge.telegram_code_hash);
}
