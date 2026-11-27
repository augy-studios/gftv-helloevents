// POST /api/auth/verify  { challenge, method, code? | response? }
//
// Step two of signing in: the second factor, for an account that has one
// (staff always; public accounts that chose to set one up).
//
//   method "totp"             { code }      authenticator app
//   method "backup"           { code }      a one-time backup code
//   method "telegram-send"                  send a code to the linked chat
//   method "telegram"         { code }      the code Telegram sent
//   method "passkey-options"                -> { options }
//   method "passkey"          { response }  the browser's assertion
//   method "email-send"                     email a code and a link to the
//                                           confirmed address (migrations/028)
//   method "email"            { code }      the code the email holds
//   method "email-link"       { link }      the link's token, from /login#email=,
//                                           with no challenge: it names its own.
//                                           Only in the browser that asked for
//                                           the email (email-factor.js).
//
// Five wrong answers end the challenge, on top of the rate limits.
//
// A passed factor answers only ok and sets the session cookie: the sign-in
// page moves on, and the next page asks /api/auth/session who is signed in.

import { route, guard, readJson, ok, fail, errorDetail } from '../_lib/http.js';
import { sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { createSession, findChallenge, failChallengeAttempt, deleteChallenge } from '../_lib/session.js';
import { loadAccount, canSignIn } from '../_lib/users.js';
import { totpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
import { linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { emailConfigured } from '../_lib/email.js';
import { confirmedEmail, sendEmailCode, emailCodeOk, challengeForLink, linkToken, sameBrowser } from '../_lib/email-factor.js';

// "email-link": the emailed link, followed in the browser that asked for it,
// signs that browser in. The link names its challenge; a link opened in any
// other browser (or by a mail scanner) is refused and counts as a wrong try.
async function signInWithLink(request, response, body) {
  const link = linkToken(body.link);
  if (await limited(request, response, 'secondFactor', [`l:${sha256(String(link))}`])) {
    return;
  }
  const challenge = await challengeForLink(link, 'login');
  if (!challenge) {
    return fail(response, 401, 'email_link_expired');
  }
  if (!sameBrowser(request, challenge)) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'auth.factor_failed', actorId: challenge.user_id, details: { method: 'email-link', reason: 'other_browser' } });
    return fail(response, 401, 'email_link_other_browser');
  }
  const user = await loadAccount(challenge.user_id, { withSecrets: true });
  if (!user || !canSignIn(user) || !emailConfigured() || !(await confirmedEmail(user))) {
    await deleteChallenge(challenge);
    return fail(response, 403, 'no_access');
  }
  await deleteChallenge(challenge);
  await createSession(request, response, user, 'email');
  await audit(request, { action: 'auth.signed_in', actorId: user.id, details: { method: 'email-link' } });
  return ok(response);
}

// "email-send": a code and a link to the confirmed address.
async function sendSignInEmail(request, response, challenge, user) {
  if (!emailConfigured()) {
    return fail(response, 400, 'email_off');
  }
  const address = await confirmedEmail(user);
  if (!address) {
    return fail(response, 400, 'email_not_confirmed');
  }
  if (await limited(request, response, 'emailSend', [`u:${user.id}`])) {
    return;
  }
  try {
    await sendEmailCode(request, response, challenge, { purpose: 'sign-in', account: user, address });
  } catch (cause) {
    console.error('[helloevents] sign-in email:', errorDetail(cause));
    return fail(response, 502, 'email_send_failed');
  }
  return ok(response, { sent: true });
}

// Checks the second factor the person chose against the sign-in challenge
// from /api/auth/login, and signs them in when it is right.
export default route('auth/verify', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (body.method === 'email-link') {
    await signInWithLink(request, response, body);
    return;
  }
  let typedChallenge = '';
  if (body.challenge !== null && body.challenge !== undefined) {
    typedChallenge = body.challenge;
  }
  if (await limited(request, response, 'secondFactor', [`c:${sha256(String(typedChallenge))}`])) {
    return;
  }

  const challenge = await findChallenge(body.challenge, 'login');
  if (!challenge) {
    return fail(response, 401, 'challenge_expired');
  }
  const user = await loadAccount(challenge.user_id, { withSecrets: true });
  if (!user || !canSignIn(user)) {
    await deleteChallenge(challenge);
    return fail(response, 403, 'no_access');
  }

  let passed = false;
  switch (body.method) {
    case 'totp':
      passed = await totpOk(user, body.code);
      break;
    case 'backup':
      passed = await spendBackupCode(user, body.code);
      break;
    case 'telegram-send': {
      if (!telegramConfigured()) {
        return fail(response, 400, 'telegram_off');
      }
      const chat = await linkedChat(user.id);
      if (!chat) {
        return fail(response, 400, 'telegram_not_linked');
      }
      if (await limited(request, response, 'telegramSend', [`u:${user.id}`])) {
        return;
      }
      await sendTelegramCode(challenge, chat.chat_id, { purpose: 'sign-in', username: user.username });
      return ok(response, { sent: true });
    }
    case 'telegram':
      passed = await telegramCodeOk(challenge, body.code);
      break;
    case 'passkey-options': {
      const options = await authenticationOptions(user.id);
      if (!options) {
        return fail(response, 400, 'no_passkeys');
      }
      return ok(response, { options });
    }
    case 'passkey':
      passed = await finishAuthentication(user.id, body.response);
      break;
    case 'email-send':
      await sendSignInEmail(request, response, challenge, user);
      return;
    case 'email':
      if (emailConfigured() && (await confirmedEmail(user))) {
        passed = await emailCodeOk(challenge, body.code);
      }
      break;
    default:
      return fail(response, 400, 'bad_request');
  }

  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'auth.factor_failed', actorId: user.id, details: { method: body.method } });
    return fail(response, 401, 'code_wrong');
  }

  await deleteChallenge(challenge);
  await createSession(request, response, user, body.method);
  await audit(request, { action: 'auth.signed_in', actorId: user.id, details: { method: body.method } });
  ok(response);
});
