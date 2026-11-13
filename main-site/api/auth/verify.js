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
//
// Five wrong answers end the challenge, on top of the rate limits.
//
// A passed factor answers only ok and sets the session cookie: the sign-in
// page moves on, and the next page asks /api/auth/session who is signed in.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { createSession, findChallenge, failChallengeAttempt, deleteChallenge } from '../_lib/session.js';
import { loadAccount, canSignIn } from '../_lib/users.js';
import { totpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
import { linkedChat, telegramConfigured } from '../_lib/telegram.js';

export default route('auth/verify', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'secondFactor', [`c:${sha256(String(body.challenge ?? ''))}`])) return;

  const challenge = await findChallenge(body.challenge, 'login');
  if (!challenge) return fail(response, 401, 'challenge_expired');
  const user = await loadAccount(challenge.user_id, { auth: true });
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
      if (!telegramConfigured()) return fail(response, 400, 'telegram_off');
      const chat = await linkedChat(user.id);
      if (!chat) return fail(response, 400, 'telegram_not_linked');
      if (await limited(request, response, 'telegramSend', [`u:${user.id}`])) return;
      await sendTelegramCode(challenge, chat.chat_id, { purpose: 'sign-in', username: user.username });
      return ok(response, { sent: true });
    }
    case 'telegram':
      passed = await telegramCodeOk(challenge, body.code);
      break;
    case 'passkey-options': {
      const options = await authenticationOptions(user.id);
      if (!options) return fail(response, 400, 'no_passkeys');
      return ok(response, { options });
    }
    case 'passkey':
      passed = await finishAuthentication(user.id, body.response);
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
