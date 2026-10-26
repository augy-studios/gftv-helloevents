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

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { createSession, findChallenge, failChallengeAttempt, deleteChallenge } from '../_lib/session.js';
import { loadAccount, canSignIn } from '../_lib/users.js';
import { totpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
import { linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { selfView } from '../_lib/serialize.js';

export default route('auth/verify', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'secondFactor', [`c:${sha256(String(body.challenge ?? ''))}`])) return;

  const challenge = await findChallenge(body.challenge, 'login');
  if (!challenge) return fail(res, 401, 'challenge_expired');
  const user = await loadAccount(challenge.user_id, { auth: true });
  if (!user || !canSignIn(user)) {
    await deleteChallenge(challenge);
    return fail(res, 403, 'no_access');
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
      if (!telegramConfigured()) return fail(res, 400, 'telegram_off');
      const chat = await linkedChat(user.id);
      if (!chat) return fail(res, 400, 'telegram_not_linked');
      if (await limited(req, res, 'telegramSend', [`u:${user.id}`])) return;
      await sendTelegramCode(challenge, chat.chat_id, { purpose: 'sign-in', username: user.username });
      return ok(res, { sent: true });
    }
    case 'telegram':
      passed = await telegramCodeOk(challenge, body.code);
      break;
    case 'passkey-options': {
      const options = await authenticationOptions(user.id);
      if (!options) return fail(res, 400, 'no_passkeys');
      return ok(res, { options });
    }
    case 'passkey':
      passed = await finishAuthentication(user.id, body.response);
      break;
    default:
      return fail(res, 400, 'bad_request');
  }

  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(req, { action: 'auth.factor_failed', actorId: user.id, details: { method: body.method } });
    return fail(res, 401, 'code_wrong');
  }

  await deleteChallenge(challenge);
  await createSession(req, res, user, body.method);
  await audit(req, { action: 'auth.signed_in', actorId: user.id, details: { method: body.method } });
  ok(res, { user: selfView(user) });
});
