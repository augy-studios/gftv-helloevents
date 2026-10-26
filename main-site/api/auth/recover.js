// POST /api/auth/recover { action, ... }  A forgotten password, public
// accounts only. Staff reset theirs on gftv.asia.
//
// There is no email sender, so the only way back in without the password is
// Telegram, the same arrangement as OneLink GFTV: a code sent to the chat
// linked on the account page, plus the second factor when the account has
// one (authenticator, passkey or a backup code). An account with no linked
// Telegram cannot reset its password here, and the page says so.
//
//   start            { identifier }  -> { telegram, staff?, challenge?, factor? }
//   send             { challenge }
//   passkey-options  { challenge, telegramCode }  -> { options }
//   finish           { challenge, telegramCode, newPassword,
//                      factor?: "totp" | "backup" | "passkey", code?, response? }
//
// Finishing sets the new password (bcrypt), signs every other device out,
// and signs this one in.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { hashPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { telegramConfigured, sendTelegram, linkedChat } from '../_lib/telegram.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { methodsFor, totpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
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

export default route('auth/recover', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;

  if (body.action === 'start') {
    const identifier = String(body.identifier ?? '').trim().toLowerCase().slice(0, 254);
    if (await limited(req, res, 'recover', [`id:${sha256(identifier)}`])) return;
    const { staff, member } = await findForLogin(identifier);
    if (!member && staff) return ok(res, { telegram: false, staff: true });
    if (!member || !canSignIn(member) || !telegramConfigured()) return ok(res, { telegram: false });
    if (!(await linkedChat(member.id))) return ok(res, { telegram: false });
    const methods = await methodsFor(member);
    const challenge = await createChallenge({ purpose: 'recover', userId: member.id });
    return ok(res, { telegram: true, challenge, factor: { totp: methods.totp, passkey: methods.passkey, backup: methods.backup, required: methods.totp || methods.passkey } });
  }

  const challenge = await findChallenge(body.challenge, 'recover');
  if (!challenge) return fail(res, 401, 'challenge_expired');
  const account = await loadAccount(challenge.user_id, { auth: true });
  const chat = account ? await linkedChat(account.id) : null;
  if (!account || account.kind !== 'public' || !canSignIn(account) || !chat) {
    await deleteChallenge(challenge);
    return fail(res, 401, 'challenge_expired');
  }

  if (body.action === 'send') {
    if (await limited(req, res, 'telegramSend', [`u:${account.id}`])) return;
    await sendTelegramCode(challenge, chat.chat_id, { purpose: 'reset', username: account.username });
    return ok(res, { sent: true });
  }

  if (body.action === 'passkey-options') {
    if (await limited(req, res, 'secondFactor', [`c:${challenge.id}`])) return;
    if (!(await telegramCodeOk(challenge, body.telegramCode))) {
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

  // Telegram first, so a wrong Telegram code never spends a backup code.
  let passed = await telegramCodeOk(challenge, body.telegramCode);
  const methods = await methodsFor(account);
  if (passed && (methods.totp || methods.passkey)) {
    if (body.factor === 'totp') passed = await totpOk(account, body.code);
    else if (body.factor === 'backup') passed = await spendBackupCode(account, body.code);
    else if (body.factor === 'passkey') passed = await finishAuthentication(account.id, body.response);
    else passed = false;
  }
  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(req, { action: 'recover.failed', actorId: account.id });
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
  await createSession(req, res, account, body.factor && (methods.totp || methods.passkey) ? body.factor : 'telegram');
  await audit(req, { action: 'recover.password_reset', actorId: account.id, details: { factor: body.factor ?? 'telegram' } });
  sendTelegram(chat.chat_id, `The password for your GFTV HelloEvents account ${account.username} was just reset, and every other device was signed out.`).catch(
    (cause) => console.warn('[helloevents] reset notice not sent:', cause?.message ?? cause)
  );
  ok(res, { user: selfView(account) });
});
