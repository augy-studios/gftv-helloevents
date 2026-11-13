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
import { database, TABLES } from './supabase.js';
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

// Supabase answers data: null when a query returns nothing; read that as no
// rows.
function rowsOrEmpty(rows) {
  if (rows === null || rows === undefined) {
    return [];
  }
  return rows;
}

// Supabase's exact count, or 0 when it gives none.
function countOrZero(count) {
  if (count === null || count === undefined) {
    return 0;
  }
  return count;
}

async function eventsTotpSecret(userId) {
  const { data, error } = await database().from(TABLES.totp).select('secret_enc').eq('user_id', userId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  const encryptedSecret = data.secret_enc;
  return decryptSecret(encryptedSecret);
}

export async function hasLocalTotp(userId) {
  const { data, error } = await database().from(TABLES.totp).select('user_id').eq('user_id', userId).maybeSingle();
  if (error) {
    throw error;
  }
  return Boolean(data);
}

export async function saveEventsTotp(userId, plainSecret) {
  const { error } = await database()
    .from(TABLES.totp)
    .upsert(
      { user_id: userId, secret_enc: encryptSecret(plainSecret), created_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) {
    throw error;
  }
}

// Whether code is right for the gftv.asia authenticator or, failing that,
// one set up on this site.
export async function totpOk(user, code) {
  if (user.totp_secret && verifyTotp(code, user.totp_secret)) {
    return true;
  }
  const localSecret = await eventsTotpSecret(user.id);
  if (!localSecret) {
    return false;
  }
  return verifyTotp(code, localSecret);
}

async function sharedBackupCount(account) {
  if (account.kind !== 'staff') {
    return 0;
  }
  const userId = account.id;
  const { count, error } = await database()
    .from(TABLES.sharedBackupCodes)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
  return countOrZero(count);
}

export async function localBackupCount(userId) {
  const { count, error } = await database()
    .from(TABLES.backupCodes)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('used', false);
  if (error) {
    throw error;
  }
  return countOrZero(count);
}

// { totp, passkey, telegram, backup } for the sign-in page. user is a
// normalised account loaded with { auth: true }, since the shared secret is
// part of it. The five lookups run at the same time.
export async function methodsFor(user) {
  // A shared authenticator is enough, so this site's own is only looked up
  // when there is none.
  let localTotpLookup = true;
  if (!user.totp_secret) {
    localTotpLookup = hasLocalTotp(user.id);
  }
  const passkeyLookup = countPasskeys(user.id);
  let chatLookup;
  if (telegramConfigured()) {
    chatLookup = linkedChat(user.id);
  } else {
    chatLookup = Promise.resolve(null);
  }
  const sharedBackupLookup = sharedBackupCount(user);
  const localBackupLookup = localBackupCount(user.id);

  const [hasLocal, passkeyCount, chat, sharedBackups, localBackups] = await Promise.all([
    localTotpLookup,
    passkeyLookup,
    chatLookup,
    sharedBackupLookup,
    localBackupLookup,
  ]);

  let hasTotp = false;
  if (user.totp_secret || hasLocal === true) {
    hasTotp = true;
  }
  return {
    totp: hasTotp,
    passkey: passkeyCount > 0,
    telegram: Boolean(chat),
    backup: sharedBackups + localBackups > 0,
  };
}

// Whether 2FA is on. For staff, any of the three. For a public account only
// an authenticator or a passkey switches it on: a linked Telegram chat is
// also how notices and password resets arrive, and linking it for those
// should not start demanding a code at every sign-in. Once 2FA is on,
// Telegram is accepted as the second step too.
export function hasSecondFactor(methods, account = null) {
  if (account !== null && account !== undefined && account.kind === 'public') {
    if (methods.totp || methods.passkey) {
      return true;
    }
    return false;
  }
  if (methods.totp || methods.passkey || methods.telegram) {
    return true;
  }
  return false;
}

// Spend one backup code, this site's first, then the shared ones. True if one
// matched. Shared codes come in two formats depending on which GFTV site
// issued them: bcrypt of the lowercased code (careers-gftv), or SHA-256 of
// the uppercased code with its hyphen removed (gftv-redirects-portal). The
// matching shared row is deleted, as every GFTV site does.
// account: a normalised account; only staff have shared codes.
export async function spendBackupCode(account, typed) {
  const userId = account.id;
  if (normaliseCode(typed).length < 6) {
    return false;
  }

  const localMatch = await findLocalBackupCode(userId, typed);
  if (localMatch) {
    return markBackupCodeUsed(localMatch.id);
  }

  if (account.kind !== 'staff') {
    return false;
  }
  const sharedMatch = await findSharedBackupCode(userId, typed);
  if (!sharedMatch) {
    return false;
  }
  return deleteSharedBackupCode(sharedMatch.id);
}

// The unused code of this site's that matches typed, or null.
async function findLocalBackupCode(userId, typed) {
  const { data: localCodes, error } = await database()
    .from(TABLES.backupCodes)
    .select('id, code_hash')
    .eq('user_id', userId)
    .eq('used', false);
  if (error) {
    throw error;
  }
  return findMatchingCode(typed, rowsOrEmpty(localCodes));
}

// Marks one of this site's codes used. Conditional on used = false, so two
// requests racing the same code cannot both succeed. True if this one did.
async function markBackupCodeUsed(codeId) {
  const { data: spent, error } = await database()
    .from(TABLES.backupCodes)
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', codeId)
    .eq('used', false)
    .select('id');
  if (error) {
    throw error;
  }
  return rowsOrEmpty(spent).length === 1;
}

// The shared code that matches typed, in either format, or null. Every row
// is checked, without stopping at the first match.
async function findSharedBackupCode(userId, typed) {
  const { data: sharedCodes, error } = await database()
    .from(TABLES.sharedBackupCodes)
    .select('id, code_hash')
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
  const normalised = normaliseCode(typed);
  const legacyHash = sha256(String(typed).trim().toUpperCase().replace(/\s/g, '').replace('-', ''));
  let matched = null;
  for (const row of rowsOrEmpty(sharedCodes)) {
    let storedHash = '';
    if (row.code_hash) {
      storedHash = String(row.code_hash);
    }
    let isMatch;
    if (storedHash.startsWith('$2')) {
      isMatch = await bcrypt.compare(normalised, storedHash);
    } else {
      isMatch = safeEqual(storedHash, legacyHash);
    }
    if (isMatch && !matched) {
      matched = row;
    }
  }
  return matched;
}

// Deletes a spent shared code, as every GFTV site does. True if this request
// deleted it.
async function deleteSharedBackupCode(codeId) {
  const { data: deleted, error } = await database()
    .from(TABLES.sharedBackupCodes)
    .delete()
    .eq('id', codeId)
    .select('id');
  if (error) {
    throw error;
  }
  return rowsOrEmpty(deleted).length === 1;
}

// A fresh set of ten of this site's codes, replacing any old set. Returns
// the plain codes, which are shown once and never again. Shared codes on
// gftvhello_backup_codes are left alone.
export async function issueBackupCodes(userId) {
  const codes = generateBackupCodes(10);
  const rows = await Promise.all(codes.map(async (code) => ({ user_id: userId, code_hash: await hashCode(code) })));
  const { error: deleteError } = await database().from(TABLES.backupCodes).delete().eq('user_id', userId);
  if (deleteError) {
    throw deleteError;
  }
  const { error } = await database().from(TABLES.backupCodes).insert(rows);
  if (error) {
    throw error;
  }
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

// Whether typed is the challenge's Telegram code and it has not expired.
export async function telegramCodeOk(challenge, typed) {
  if (!challenge.telegram_code_hash || !challenge.telegram_code_expires_at) {
    return false;
  }
  if (new Date(challenge.telegram_code_expires_at).getTime() <= Date.now()) {
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
  return bcrypt.compare(digits, challenge.telegram_code_hash);
}

// After a second factor is added (authenticator or passkey): ten backup
// codes if the account has none to fall back on, so everyone who turns 2FA
// on can get back in, and can reset a forgotten password with one
// (recover.js). Returns the plain codes to show once, or null.
export async function backupCodesForNewFactor(account) {
  if ((await localBackupCount(account.id)) > 0) {
    return null;
  }
  if ((await sharedBackupCount(account)) > 0) {
    return null;
  }
  return issueBackupCodes(account.id);
}
