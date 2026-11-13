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
//   start            { identifier, "cf-turnstile-response"? }
//                       -> { found: true, challenge, telegram, backup, factor }
//                          for a public account that may sign in, and
//                          exactly { found: false } for anything else: an
//                          unknown name, a suspended account, and a staff
//                          account alike (help desk #18), so the answer never
//                          says whether a staff account exists. Second factors
//                          are listed only in the first answer.
//                    Turnstile, action "reset" (turnstile.js). Every later
//                    step needs the challenge this hands out, so one check
//                    covers each reset, whichever way it goes.
//   send             { challenge }                       Telegram code
//   passkey-options  { challenge, telegramCode }  -> { options }
//   finish           { challenge, method, newPassword, ... }
//      method "telegram":   telegramCode, and factor + code/response when 2FA is on
//      method "backup":     code
//      method "staff-code": resetCode
//
// Finishing sets the new password (bcrypt), signs every other device out,
// and signs this one in (except a staff code on an account with 2FA, which
// only sets the password). 2FA, when on, stays on. -> { signedIn }, and the
// page goes on to /account or to "sign in now".

import { route, guard, readJson, ok, fail, errorDetail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { hashPassword, sha256, normaliseCode } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';
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

// A staff-issued reset code, spent if it is live for this account.
async function spendStaffCode(accountId, typed) {
  const code = normaliseCode(typed);
  if (code.length < 10) {
    return false;
  }
  const { data, error } = await database()
    .from(TABLES.passwordResets)
    .update({ used_at: new Date().toISOString() })
    .eq('code_hash', sha256(code))
    .eq('account_id', accountId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id');
  if (error) {
    throw error;
  }
  let spentRows = [];
  if (data !== null && data !== undefined) {
    spentRows = data;
  }
  return spentRows.length === 1;
}

// Step "start": looks the name up and, for a public account that may sign
// in, hands out the challenge every later step needs, with the ways back in
// it has. Anything else gets exactly { found: false }.
async function startRecovery(request, response, body) {
  let typedIdentifier = '';
  if (body.identifier !== null && body.identifier !== undefined) {
    typedIdentifier = body.identifier;
  }
  const identifier = String(typedIdentifier).trim().toLowerCase().slice(0, 254);
  if (await limited(request, response, 'recover', [`id:${sha256(identifier)}`])) {
    return;
  }
  if (await refusedForTurnstile(request, response, body, 'reset')) {
    return;
  }
  // Only a public account is looked at. A staff-only name gets the same
  // answer as a name nobody has: staff reset their password on gftv.asia,
  // and the reset page says so to everyone it cannot help.
  const { member } = await findForLogin(identifier);
  if (!member || !canSignIn(member)) {
    return ok(response, { found: false });
  }
  const methods = await methodsFor(member);
  const twoFactor = hasSecondFactor(methods, member);
  // Telegram is a way back in only when the bot is set up and a chat is linked.
  let telegram = false;
  if (telegramConfigured()) {
    telegram = Boolean(await linkedChat(member.id));
  }
  const challenge = await createChallenge({ purpose: 'recover', userId: member.id });
  // A backup code is a way back in only when 2FA is on.
  let backup = false;
  if (twoFactor) {
    backup = methods.backup;
  }
  return ok(response, {
    found: true,
    challenge,
    telegram,
    backup,
    factor: { totp: methods.totp, passkey: methods.passkey, backup: methods.backup, required: twoFactor },
  });
}

// The challenge "start" handed out, and the account it belongs to, or null
// after answering 401. A challenge for an account that can no longer reset
// here (gone, staff, or suspended) is ended.
async function loadRecovery(response, body) {
  const challenge = await findChallenge(body.challenge, 'recover');
  if (!challenge) {
    fail(response, 401, 'challenge_expired');
    return null;
  }
  const account = await loadAccount(challenge.user_id, { withSecrets: true });
  if (!account || account.kind !== 'public' || !canSignIn(account)) {
    await deleteChallenge(challenge);
    fail(response, 401, 'challenge_expired');
    return null;
  }
  return { challenge, account };
}

// Step "send": a reset code to the linked Telegram chat.
async function sendResetCode(request, response, { challenge, account, chat }) {
  if (!chat) {
    return fail(response, 400, 'telegram_not_linked');
  }
  if (await limited(request, response, 'telegramSend', [`u:${account.id}`])) {
    return;
  }
  await sendTelegramCode(challenge, chat.chat_id, { purpose: 'reset', username: account.username });
  return ok(response, { sent: true });
}

// Step "passkey-options": the passkey ceremony for an account with 2FA,
// handed out only once the Telegram code is right.
async function passkeyOptions(request, response, body, { challenge, account, chat }) {
  if (await limited(request, response, 'secondFactor', [`c:${challenge.id}`])) {
    return;
  }
  if (!chat || !(await telegramCodeOk(challenge, body.telegramCode))) {
    await failChallengeAttempt(challenge);
    return fail(response, 401, 'code_wrong');
  }
  const options = await authenticationOptions(account.id);
  if (!options) {
    return fail(response, 400, 'no_passkeys');
  }
  return ok(response, { options });
}

// The second factor sent with a right Telegram code, when 2FA is on: an
// authenticator code, a backup code or a passkey.
async function secondFactorPassed(body, account) {
  if (body.factor === 'totp') {
    return totpOk(account, body.code);
  }
  if (body.factor === 'backup') {
    return spendBackupCode(account, body.code);
  }
  if (body.factor === 'passkey') {
    return finishAuthentication(account.id, body.response);
  }
  return false;
}

// Whether the proof sent with "finish" is right for the way back in chosen.
async function proofPassed(body, method, { challenge, account, chat, twoFactor }) {
  if (method === 'telegram') {
    // Telegram first, so a wrong Telegram code never spends a backup code.
    let passed = false;
    if (chat) {
      passed = await telegramCodeOk(challenge, body.telegramCode);
    }
    if (passed && twoFactor) {
      passed = await secondFactorPassed(body, account);
    }
    return passed;
  }
  if (method === 'backup') {
    if (twoFactor) {
      return spendBackupCode(account, body.code);
    }
    return false;
  }
  return spendStaffCode(account.id, body.resetCode);
}

// Sets the new password (bcrypt) on the public account.
async function saveNewPassword(accountId, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  const changedAt = new Date().toISOString();
  const { error } = await database()
    .from(TABLES.accounts)
    .update({ password_hash: passwordHash, password_changed_at: changedAt })
    .eq('id', accountId)
    .eq('kind', 'public');
  if (error) {
    throw error;
  }
}

// What the new session records as its second step: the factor sent with the
// Telegram code when 2FA is on, otherwise the way back in itself ("password"
// for a staff code).
function sessionFactor(method, twoFactor, body) {
  if (method === 'telegram') {
    if (twoFactor) {
      return body.factor;
    }
    return 'telegram';
  }
  if (method === 'backup') {
    return 'backup';
  }
  return 'password';
}

// Tells the linked chat the password was reset. Not waited for: a notice
// that fails is logged, and the reset still stands.
function sendResetNotice(chat, account) {
  sendTelegram(
    chat.chat_id,
    `The password for your GFTV HelloEvents account ${account.username} was just reset, and every other device was signed out.`
  ).catch((cause) => console.warn('[helloevents] reset notice not sent:', errorDetail(cause)));
}

// Step "finish": checks the proof, sets the new password, signs every other
// device out, and signs this one in unless a staff code was used on an
// account with 2FA.
async function finishRecovery(request, response, body, recovery) {
  const { challenge, account, chat } = recovery;
  if (await limited(request, response, 'secondFactor', [`c:${challenge.id}`])) {
    return;
  }

  const password = checkPassword(body.newPassword, { username: account.username });
  if (!password.ok) {
    return fail(response, 400, password.error);
  }

  const methods = await methodsFor(account);
  const twoFactor = hasSecondFactor(methods, account);
  let method = 'telegram';
  if (['telegram', 'backup', 'staff-code'].includes(body.method)) {
    method = body.method;
  }
  const passed = await proofPassed(body, method, { challenge, account, chat, twoFactor });
  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'recover.failed', actorId: account.id, details: { method } });
    return fail(response, 401, 'code_wrong');
  }

  await saveNewPassword(account.id, body.newPassword);
  await deleteChallenge(challenge);
  await endOtherSessions(account.id, null);
  await audit(request, { action: 'recover.password_reset', actorId: account.id, details: { method } });
  // A staff code proves who someone is, not that they hold their second
  // factor: with 2FA on, it only sets the password, and the sign-in that
  // follows still asks for the second step.
  let signIn = true;
  if (method === 'staff-code' && twoFactor) {
    signIn = false;
  }
  if (signIn) {
    await createSession(request, response, account, sessionFactor(method, twoFactor, body));
  }
  if (chat) {
    sendResetNotice(chat, account);
  }
  return ok(response, { signedIn: signIn });
}

// Sends each action to its step. Every step after "start" needs the challenge
// "start" handed out, still live and for a public account that may sign in.
export default route('auth/recover', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }

  if (body.action === 'start') {
    await startRecovery(request, response, body);
    return;
  }

  const found = await loadRecovery(response, body);
  if (!found) {
    return;
  }
  const { challenge, account } = found;
  let chat = null;
  if (telegramConfigured()) {
    chat = await linkedChat(account.id);
  }
  const recovery = { challenge, account, chat };

  if (body.action === 'send') {
    await sendResetCode(request, response, recovery);
    return;
  }
  if (body.action === 'passkey-options') {
    await passkeyOptions(request, response, body, recovery);
    return;
  }
  if (body.action !== 'finish') {
    fail(response, 400, 'bad_request');
    return;
  }
  await finishRecovery(request, response, body, recovery);
});
