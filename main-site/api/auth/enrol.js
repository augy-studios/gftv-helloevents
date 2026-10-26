// POST /api/auth/enrol  { challenge, action, ... }
//
// The mandatory 2FA gate for an account with no second factor yet. The
// password has been checked (login.js answered step: "setup"); no session
// exists until one of these finishes:
//
//   action "totp-start"                      -> { secret, uri }
//   action "totp-finish"     { code }        authenticator app
//   action "passkey-options"                 -> { options }
//   action "passkey-finish"  { response, label? }
//   action "telegram-link"                   -> { url, expiresInMinutes }
//   action "telegram-status"                 -> { codeSent }
//   action "telegram-finish" { code }        the code the bot sent
//
// Finishing sets the factor up on this site only (never in gftvhello_users),
// issues ten backup codes for this site, shown once, and signs the person in:
//   -> { user, backupCodes }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { sha256, encryptSecret, decryptSecret } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { registrationOptions, finishRegistration } from '../_lib/webauthn.js';
import {
  createSession,
  findChallenge,
  failChallengeAttempt,
  deleteChallenge,
  updateChallenge,
} from '../_lib/session.js';
import { findUserById, USER_COLUMNS, canSignIn } from '../_lib/users.js';
import { saveEventsTotp, issueBackupCodes, telegramCodeOk } from '../_lib/factors.js';
import { createLinkToken, saveLink, telegramConfigured } from '../_lib/telegram.js';
import { selfView } from '../_lib/serialize.js';
import { LIMITS } from '../_lib/event-rules.js';

function label(value) {
  const text = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text.slice(0, LIMITS.label) || null;
}

export default route('auth/enrol', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'enrol', [`c:${sha256(String(body.challenge ?? ''))}`])) return;

  const challenge = await findChallenge(body.challenge, 'enrol');
  if (!challenge) return fail(res, 401, 'challenge_expired');
  const user = await findUserById(challenge.user_id, USER_COLUMNS);
  if (!user || !canSignIn(user)) {
    await deleteChallenge(challenge);
    return fail(res, 403, 'no_access');
  }

  async function finish(method) {
    await deleteChallenge(challenge);
    const backupCodes = await issueBackupCodes(user.id);
    await createSession(req, res, user.id, method);
    await audit(req, { action: 'auth.factor_set_up', actorId: user.id, details: { method } });
    await audit(req, { action: 'auth.signed_in', actorId: user.id, details: { method, first: true } });
    return ok(res, { user: selfView(user), backupCodes });
  }

  async function wrong() {
    await failChallengeAttempt(challenge);
    await audit(req, { action: 'auth.setup_failed', actorId: user.id, details: { action: body.action } });
    return fail(res, 401, 'code_wrong');
  }

  switch (body.action) {
    case 'totp-start': {
      const secret = generateTotpSecret();
      await updateChallenge(challenge, { pending_totp_secret: encryptSecret(secret) });
      return ok(res, { secret, uri: otpauthUri({ account: user.username, secret }) });
    }

    case 'totp-finish': {
      const secret = decryptSecret(challenge.pending_totp_secret);
      if (!secret) return fail(res, 400, 'setup_not_started');
      if (!verifyTotp(body.code, secret)) return wrong();
      await saveEventsTotp(user.id, secret);
      return finish('totp');
    }

    case 'passkey-options':
      return ok(res, { options: await registrationOptions(user) });

    case 'passkey-finish': {
      const result = await finishRegistration(user.id, body.response, label(body.label));
      if (!result.ok) {
        await failChallengeAttempt(challenge);
        return fail(res, 400, result.error);
      }
      return finish('passkey');
    }

    case 'telegram-link': {
      if (!telegramConfigured()) return fail(res, 400, 'telegram_off');
      // A fresh link clears any code an earlier link sent.
      await updateChallenge(challenge, {
        telegram_code_hash: null,
        telegram_code_expires_at: null,
        pending_telegram_chat_id: null,
        pending_telegram_username: null,
      });
      return ok(res, await createLinkToken(user.id, challenge.id));
    }

    case 'telegram-status':
      return ok(res, { codeSent: Boolean(challenge.pending_telegram_chat_id && challenge.telegram_code_hash) });

    case 'telegram-finish': {
      if (!challenge.pending_telegram_chat_id) return fail(res, 400, 'telegram_not_ready');
      if (!(await telegramCodeOk(challenge, body.code))) return wrong();
      await saveLink(user.id, challenge.pending_telegram_chat_id, challenge.pending_telegram_username);
      return finish('telegram');
    }

    default:
      return fail(res, 400, 'bad_request');
  }
});
