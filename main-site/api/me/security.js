// The signed-in person's second factors on this site, and (public accounts)
// deleting the account.
//
// GET                                           -> summary (below)
// POST { action: "totp-start", password }       -> { secret, uri }
// POST { action: "totp-finish", setup, code }   the first code proves it
// POST { action: "totp-remove", password }
// POST { action: "passkey-options", password }  -> { options }
// POST { action: "passkey-finish", response, label? }
// POST { action: "passkey-remove", id, password }
// POST { action: "telegram-link" }              -> { url, expiresInMinutes }
// POST { action: "telegram-unlink", password }
// POST { action: "backup-regenerate", password } -> { codes }
// POST { action: "delete-account", password }   public accounts only
//
// The password is asked for again before anything that adds or removes a way
// in. For staff, removing the last second factor is refused (staff must
// always have one). For public accounts 2FA is optional, so they may.
//
// The authenticator app set up on gftv.asia is shown but not changed here;
// it lives with the shared staff account.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { verifyPassword, encryptSecret, decryptSecret } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { db, T } from '../_lib/supabase.js';
import { requireUser, createChallenge, findChallenge, updateChallenge, failChallengeAttempt, deleteChallenge, endSession } from '../_lib/session.js';
import { loadAccount, secondFactorRequired } from '../_lib/users.js';
import { listPasskeys, registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { methodsFor, hasSecondFactor, issueBackupCodes, localBackupCount, hasLocalTotp, saveEventsTotp } from '../_lib/factors.js';
import { createLinkToken, linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { forgetAllSubscriptions } from '../_lib/push.js';
import { passkeyView } from '../_lib/serialize.js';
import { LIMITS } from '../_lib/event-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function summary(userId) {
  const user = await loadAccount(userId, { auth: true });
  const [passkeys, chat, backupLeft, localTotp] = await Promise.all([
    listPasskeys(userId),
    linkedChat(userId),
    localBackupCount(userId),
    hasLocalTotp(userId),
  ]);
  return {
    kind: user.kind,
    required: secondFactorRequired(user),
    totp: { shared: Boolean(user.totp_secret), local: localTotp },
    passkeys: passkeys.map(passkeyView),
    telegram: {
      available: telegramConfigured(),
      linked: Boolean(chat),
      // The handle, so the person can tell which chat it is. Never the chat id.
      username: chat?.telegram_username || null,
    },
    backupCodesLeft: backupLeft,
  };
}

// Whether the account would still have a second factor without `without`.
async function wouldKeepAFactor(user, without) {
  const methods = await methodsFor(user);
  if (without === 'telegram') methods.telegram = false;
  if (without === 'totp') methods.totp = Boolean(user.totp_secret);
  if (without === 'passkey') methods.passkey = (await listPasskeys(user.id)).length - 1 > 0;
  return hasSecondFactor(methods, user);
}

export default route('me/security', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const session = await requireUser(req, res);
  if (!session) return;
  const userId = session.user.id;

  if (req.method === 'GET') return ok(res, await summary(userId));

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'securityWrite', [`u:${userId}`])) return;

  const user = await loadAccount(userId, { auth: true });
  const passwordOk = async () => {
    if (await limited(req, res, 'reauth', [`u:${userId}`])) return null;
    const right = await verifyPassword(body.password, user.password_hash);
    if (!right) fail(res, 401, 'password_wrong');
    return right;
  };
  const mayRemove = async (what) => !secondFactorRequired(user) || (await wouldKeepAFactor(user, what));

  switch (body.action) {
    case 'totp-start': {
      if (user.totp_secret || (await hasLocalTotp(userId))) return fail(res, 409, 'totp_exists');
      if (!(await passwordOk())) return;
      const secret = generateTotpSecret();
      const setup = await createChallenge({ purpose: 'totp-setup', userId });
      // The pending secret waits, encrypted, on the challenge row.
      await updateChallenge(await findChallenge(setup, 'totp-setup'), { pending_totp_secret: encryptSecret(secret) });
      return ok(res, { setup, secret, uri: otpauthUri({ account: user.username, secret }) });
    }
    case 'totp-finish': {
      const challenge = await findChallenge(body.setup, 'totp-setup');
      const secret = challenge && challenge.user_id === userId ? decryptSecret(challenge.pending_totp_secret) : null;
      if (!secret) return fail(res, 400, 'setup_not_started');
      if (!verifyTotp(body.code, secret)) {
        await failChallengeAttempt(challenge);
        return fail(res, 401, 'code_wrong');
      }
      await saveEventsTotp(userId, secret);
      await deleteChallenge(challenge);
      // The first factor on a public account comes with backup codes.
      const codes = (await localBackupCount(userId)) === 0 ? await issueBackupCodes(userId) : null;
      await audit(req, { action: 'security.totp_added', actorId: userId });
      return ok(res, { ...(await summary(userId)), codes });
    }
    case 'totp-remove': {
      if (!(await passwordOk())) return;
      if (!(await mayRemove('totp'))) return fail(res, 409, 'last_factor');
      const { error } = await db().from(T.totp).delete().eq('user_id', userId);
      if (error) throw error;
      await audit(req, { action: 'security.totp_removed', actorId: userId });
      return ok(res, await summary(userId));
    }
    case 'passkey-options': {
      if (!(await passwordOk())) return;
      return ok(res, { options: await registrationOptions(user) });
    }
    case 'passkey-finish': {
      const name = String(body.label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.label) || null;
      const result = await finishRegistration(userId, body.response, name);
      if (!result.ok) return fail(res, 400, result.error);
      await audit(req, { action: 'security.passkey_added', actorId: userId });
      return ok(res, await summary(userId));
    }
    case 'passkey-remove': {
      if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');
      if (!(await passwordOk())) return;
      if (!(await mayRemove('passkey'))) return fail(res, 409, 'last_factor');
      await removePasskey(userId, body.id);
      await audit(req, { action: 'security.passkey_removed', actorId: userId });
      return ok(res, await summary(userId));
    }
    case 'telegram-link': {
      if (!telegramConfigured()) return fail(res, 400, 'telegram_off');
      return ok(res, await createLinkToken(userId, null));
    }
    case 'telegram-unlink': {
      if (!(await passwordOk())) return;
      if (!(await mayRemove('telegram'))) return fail(res, 409, 'last_factor');
      const { error } = await db().from(T.telegram).delete().eq('user_id', userId);
      if (error) throw error;
      await audit(req, { action: 'security.telegram_unlinked', actorId: userId, details: { via: 'site' } });
      return ok(res, await summary(userId));
    }
    case 'backup-regenerate': {
      if (!(await passwordOk())) return;
      const codes = await issueBackupCodes(userId);
      await audit(req, { action: 'security.backup_codes_issued', actorId: userId });
      return ok(res, { codes });
    }
    case 'delete-account': {
      if (user.kind !== 'public') return fail(res, 403, 'staff_account');
      if (!(await passwordOk())) return;
      // Cascades to sessions, factors, Telegram link and RSVPs; the audit
      // log keeps its rows with the actor set to null.
      await forgetAllSubscriptions(userId);
      const { error } = await db().from(T.accounts).delete().eq('id', userId).eq('kind', 'public');
      if (error) throw error;
      await endSession(req, res);
      return ok(res, { deleted: true });
    }
    default:
      return fail(res, 400, 'bad_request');
  }
});
