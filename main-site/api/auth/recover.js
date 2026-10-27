// POST /api/auth/recover { action, ... }  A forgotten password, public
// accounts only. Staff reset theirs on gftv.asia. No email is ever sent.
//
// Three ways back in, any one of which resets the password:
//
//   telegram    a code sent to the chat linked on the account page, plus the
//               second factor when 2FA is on (as on OneLink GFTV);
//   backup      one of the account's backup codes, for an account with 2FA
//               (every account that turns 2FA on is given ten);
//   staff-code  a one-time code an admin made in /manage for someone with
//               neither Telegram nor 2FA (migrations/003), after checking
//               who they are some other way.
//
//   start            { identifier }  -> { found, staff?, challenge?, telegram, backup, factor }
//   send             { challenge }                       Telegram code
//   passkey-options  { challenge, telegramCode }  -> { options }
//   finish           { challenge, method, newPassword, ... }
//      method "telegram":   telegramCode, and factor + code/response when 2FA is on
//      method "backup":     code
//      method "staff-code": resetCode
//
// Finishing sets the new password (bcrypt), signs every other device out,
// and signs this one in (except a staff code on an account with 2FA, which
// only sets the password). 2FA, when on, stays on.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { hashPassword, sha256, normaliseCode } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { telegramConfigured, sendTelegram, linkedChat } from '../_lib/telegram.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { methodsFor, hasSecondFactor, totpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
import { checkPassword } from '../_lib/account-rules.js';
import { findForLogin, loadAccount, canSignIn } from '../_lib/users.js';
import {
  createChallenge,
  findChallenge,
  failChallengeAttempt,
  deleteChallenge,
  createSession,
  endOtherSessions,
} from '../_lib/session.js';
import { selfView } from '../_lib/serialize.js';

// A staff-issued reset code, spent if it is live for this account.
async function spendStaffCode(accountId, typed) {
  const code = normaliseCode(typed);
  if (code.length < 10) return false;
  const { data, error } = await db()
    .from(T.passwordResets)
    .update({ used_at: new Date().toISOString() })
    .eq('code_hash', sha256(code))
    .eq('account_id', accountId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id');
  if (error) throw error;
  return (data ?? []).length === 1;
}

export default route('auth/recover', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;

  if (body.action === 'start') {
    const identifier = String(body.identifier ?? '').trim().toLowerCase().slice(0, 254);
    if (await limited(req, res, 'recover', [`id:${sha256(identifier)}`])) return;
    const { staff, member } = await findForLogin(identifier);
    if (!member && staff) return ok(res, { found: true, staff: true });
    if (!member || !canSignIn(member)) return ok(res, { found: false });
    const methods = await methodsFor(member);
    const twoFactor = hasSecondFactor(methods, member);
    const telegram = telegramConfigured() && Boolean(await linkedChat(member.id));
    const challenge = await createChallenge({ purpose: 'recover', userId: member.id });
    return ok(res, {
      found: true,
      challenge,
      telegram,
      backup: twoFactor && methods.backup,
      factor: { totp: methods.totp, passkey: methods.passkey, backup: methods.backup, required: twoFactor },
    });
  }

  const challenge = await findChallenge(body.challenge, 'recover');
  if (!challenge) return fail(res, 401, 'challenge_expired');
  const account = await loadAccount(challenge.user_id, { auth: true });
  if (!account || account.kind !== 'public' || !canSignIn(account)) {
    await deleteChallenge(challenge);
    return fail(res, 401, 'challenge_expired');
  }
  const chat = telegramConfigured() ? await linkedChat(account.id) : null;

  if (body.action === 'send') {
    if (!chat) return fail(res, 400, 'telegram_not_linked');
    if (await limited(req, res, 'telegramSend', [`u:${account.id}`])) return;
    await sendTelegramCode(challenge, chat.chat_id, { purpose: 'reset', username: account.username });
    return ok(res, { sent: true });
  }

  if (body.action === 'passkey-options') {
    if (await limited(req, res, 'secondFactor', [`c:${challenge.id}`])) return;
    if (!chat || !(await telegramCodeOk(challenge, body.telegramCode))) {
      await failChallengeAttempt(challenge);
      return fail(res, 401, 'code_wrong');
    }
    const options = await authenticationOptions(account.id);
    if (!options) return fail(res, 400, 'no_passkeys');
    return ok(res, { options });
  }

  if (body.action !== 'finish') return fail(res, 400, 'bad_request');
  if (await limited(req, res, 'secondFactor', [`c:${challenge.id}`])) return;

  const password = checkPassword(body.newPassword, { username: account.username });
  if (!password.ok) return fail(res, 400, password.error);

  const methods = await methodsFor(account);
  const twoFactor = hasSecondFactor(methods, account);
  const method = ['telegram', 'backup', 'staff-code'].includes(body.method) ? body.method : 'telegram';
  let passed = false;
  if (method === 'telegram') {
    // Telegram first, so a wrong Telegram code never spends a backup code.
    passed = Boolean(chat) && (await telegramCodeOk(challenge, body.telegramCode));
    if (passed && twoFactor) {
      if (body.factor === 'totp') passed = await totpOk(account, body.code);
      else if (body.factor === 'backup') passed = await spendBackupCode(account, body.code);
      else if (body.factor === 'passkey') passed = await finishAuthentication(account.id, body.response);
      else passed = false;
    }
  } else if (method === 'backup') {
    passed = twoFactor && (await spendBackupCode(account, body.code));
  } else {
    passed = await spendStaffCode(account.id, body.resetCode);
  }
  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(req, { action: 'recover.failed', actorId: account.id, details: { method } });
    return fail(res, 401, 'code_wrong');
  }

  const { error } = await db()
    .from(T.accounts)
    .update({ password_hash: await hashPassword(body.newPassword), password_changed_at: new Date().toISOString() })
    .eq('id', account.id)
    .eq('kind', 'public');
  if (error) throw error;

  await deleteChallenge(challenge);
  await endOtherSessions(account.id, null);
  await audit(req, { action: 'recover.password_reset', actorId: account.id, details: { method } });
  // A staff code proves who someone is, not that they hold their second
  // factor: with 2FA on, it only sets the password, and the sign-in that
  // follows still asks for the second step.
  const signIn = !(method === 'staff-code' && twoFactor);
  if (signIn) {
    const factor = method === 'telegram' ? (twoFactor ? body.factor : 'telegram') : method === 'backup' ? 'backup' : 'password';
    await createSession(req, res, account, factor);
  }
  if (chat) {
    sendTelegram(chat.chat_id, `The password for your GFTV HelloEvents account ${account.username} was just reset, and every other device was signed out.`).catch(
      (cause) => console.warn('[helloevents] reset notice not sent:', cause?.message ?? cause)
    );
  }
  ok(res, signIn ? { signedIn: true, user: selfView(account) } : { signedIn: false });
});
