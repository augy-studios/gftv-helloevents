// POST /api/auth/recover { action, ... }  A forgotten password, public
// accounts only. Staff reset theirs on gftv.asia.
//
// Four ways back in, any one of which resets the password:
//
//   telegram    a code sent to the chat linked on the account page, plus the
//               second factor when 2FA is on (as on OneLink GFTV);
//   email       a code (or link) emailed to the address confirmed on the
//               account page (migrations/028), plus the second factor when
//               2FA is on;
//   backup      one of the account's backup codes, for an account with 2FA
//               (every account that turns 2FA on is given ten);
//   staff-code  a one-time code an admin made in /manage for someone with
//               none of these (migrations/003), after checking who they are
//               some other way.
//
//   start            { identifier, "cf-turnstile-response"? }
//                       -> { found: true, challenge, telegram, emailCodes, backup, factor }
//                          for a public account that may sign in, and
//                          exactly { found: false } for anything else: an
//                          unknown name, a suspended account, and a staff
//                          account alike (help desk #18), so the answer never
//                          says whether a staff account exists. Second factors
//                          are listed only in the first answer.
//                    Turnstile, action "reset" (turnstile.js). Every later
//                    step needs the challenge this hands out, so one check
//                    covers each reset, whichever way it goes.
//   send             { challenge, channel? }   a Telegram code, or with
//                                              channel "email" an emailed one
//   email-link       { link }   the emailed link, from /reset#email=, in the
//                    browser that asked for it: the email way is proven, and
//                    -> what "start" answers, with a new challenge (the old
//                    one stops working) and emailVerified: true
//   passkey-options  { challenge, method?, telegramCode | emailCode }  -> { options }
//   finish           { challenge, method, newPassword, ... }
//      method "telegram":   telegramCode, and factor + code/response when 2FA is on
//      method "email":      emailCode (none after the link), and factor +
//                           code/response when 2FA is on
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
import { emailConfigured, sendEmail, resetNoticeEmail } from '../_lib/email.js';
import { confirmedEmail, sendEmailCode, emailCodeOk, challengeForLink, linkToken, sameBrowser } from '../_lib/email-factor.js';
import { findForLogin, loadAccount, canSignIn } from '../_lib/users.js';
import {
  createChallenge,
  findChallenge,
  failChallengeAttempt,
  deleteChallenge,
  createSession,
  endOtherSessions,
  renewChallenge,
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
  const challenge = await createChallenge({ purpose: 'recover', userId: member.id });
  return ok(response, await waysBackIn(member, challenge));
}

// What "start" (and "email-link") answers: the challenge, the ways back in
// the account has, and its second factors.
async function waysBackIn(member, challenge) {
  const methods = await methodsFor(member);
  const twoFactor = hasSecondFactor(methods, member);
  // Telegram is a way back in only when the bot is set up and a chat is linked.
  let telegram = false;
  if (telegramConfigured()) {
    telegram = Boolean(await linkedChat(member.id));
  }
  // A backup code is a way back in only when 2FA is on.
  let backup = false;
  if (twoFactor) {
    backup = methods.backup;
  }
  return {
    found: true,
    challenge,
    telegram,
    emailCodes: methods.emailCodes,
    backup,
    factor: { totp: methods.totp, passkey: methods.passkey, backup: methods.backup, required: twoFactor },
  };
}

// Step "email-link": the emailed link, opened in the browser that asked for
// it, proves the email way. That tab carries on with a new challenge, which
// remembers the email is proven; anywhere else, the link is refused.
async function followEmailLink(request, response, body) {
  const link = linkToken(body.link);
  if (await limited(request, response, 'secondFactor', [`l:${sha256(String(link))}`])) {
    return;
  }
  const challenge = await challengeForLink(link, 'recover');
  if (!challenge) {
    return fail(response, 401, 'email_link_expired');
  }
  if (!sameBrowser(request, challenge)) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'recover.failed', actorId: challenge.user_id, details: { method: 'email-link', reason: 'other_browser' } });
    return fail(response, 401, 'email_link_other_browser');
  }
  const account = await loadAccount(challenge.user_id, { withSecrets: true });
  if (!account || account.kind !== 'public' || !canSignIn(account) || !emailConfigured() || !(await confirmedEmail(account))) {
    await deleteChallenge(challenge);
    return fail(response, 401, 'challenge_expired');
  }
  const renewed = await renewChallenge(challenge, { email_verified_at: new Date().toISOString(), email_link_hash: null });
  return ok(response, { ...(await waysBackIn(account, renewed)), emailVerified: true });
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

// Step "send": a reset code to the linked Telegram chat, or (channel
// "email") a code and link to the confirmed address.
async function sendResetCode(request, response, body, { challenge, account, chat }) {
  if (body.channel === 'email') {
    return sendResetEmail(request, response, { challenge, account });
  }
  if (!chat) {
    return fail(response, 400, 'telegram_not_linked');
  }
  if (await limited(request, response, 'telegramSend', [`u:${account.id}`])) {
    return;
  }
  await sendTelegramCode(challenge, chat.chat_id, { purpose: 'reset', username: account.username });
  return ok(response, { sent: true });
}

async function sendResetEmail(request, response, { challenge, account }) {
  if (!emailConfigured()) {
    return fail(response, 400, 'email_off');
  }
  const address = await confirmedEmail(account);
  if (!address) {
    return fail(response, 400, 'email_not_confirmed');
  }
  if (await limited(request, response, 'emailSend', [`u:${account.id}`])) {
    return;
  }
  try {
    await sendEmailCode(request, response, challenge, { purpose: 'reset', account, address });
  } catch (cause) {
    console.error('[helloevents] reset email:', errorDetail(cause));
    return fail(response, 502, 'email_send_failed');
  }
  return ok(response, { sent: true });
}

// Whether the email way is proven: the link was followed in this browser
// (email_verified_at, set by "email-link"), or the emailed code is right.
async function emailProven(challenge, account, typed) {
  if (!emailConfigured() || !(await confirmedEmail(account))) {
    return false;
  }
  if (challenge.email_verified_at) {
    return true;
  }
  return emailCodeOk(challenge, typed);
}

// The first proof of the Telegram or email way: its code (or followed link).
async function firstProofPassed(method, body, { challenge, account, chat }) {
  if (method === 'email') {
    return emailProven(challenge, account, body.emailCode);
  }
  if (!chat) {
    return false;
  }
  return telegramCodeOk(challenge, body.telegramCode);
}

// Step "passkey-options": the passkey ceremony for an account with 2FA,
// handed out only once the Telegram or email way is proven.
async function passkeyOptions(request, response, body, recovery) {
  const { challenge, account } = recovery;
  if (await limited(request, response, 'secondFactor', [`c:${challenge.id}`])) {
    return;
  }
  let method = 'telegram';
  if (body.method === 'email') {
    method = 'email';
  }
  if (!(await firstProofPassed(method, body, recovery))) {
    await failChallengeAttempt(challenge);
    return fail(response, 401, 'code_wrong');
  }
  const options = await authenticationOptions(account.id);
  if (!options) {
    return fail(response, 400, 'no_passkeys');
  }
  return ok(response, { options });
}

// The second factor sent with a right Telegram or email code, when 2FA is
// on: an authenticator code, a backup code or a passkey.
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
async function proofPassed(body, method, recovery) {
  const { account, twoFactor } = recovery;
  if (method === 'telegram' || method === 'email') {
    // Telegram or email first, so a wrong code never spends a backup code.
    const passed = await firstProofPassed(method, body, recovery);
    if (passed && twoFactor) {
      return secondFactorPassed(body, account);
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
// Telegram or email code when 2FA is on, otherwise the way back in itself
// ("password" for a staff code).
function sessionFactor(method, twoFactor, body) {
  if (method === 'telegram' || method === 'email') {
    if (twoFactor) {
      return body.factor;
    }
    return method;
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

// Tells the confirmed address the same, the same way: not waited for.
function sendResetNoticeEmail(address, account) {
  sendEmail({ to: address, ...resetNoticeEmail({ username: account.username }) }).catch((cause) =>
    console.warn('[helloevents] reset notice email not sent:', errorDetail(cause))
  );
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
  if (['telegram', 'email', 'backup', 'staff-code'].includes(body.method)) {
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
  if (methods.emailCodes) {
    sendResetNoticeEmail(account.email, account);
  }
  return ok(response, { signedIn: signIn });
}

// Sends each action to its step. Every step after "start" (and
// "email-link", whose link names its own challenge) needs the challenge
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
  if (body.action === 'email-link') {
    await followEmailLink(request, response, body);
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
    await sendResetCode(request, response, body, recovery);
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
