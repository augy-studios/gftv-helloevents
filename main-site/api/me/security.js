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
// POST { action: "telegram-link" }              -> { url }
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
import { database, TABLES } from '../_lib/supabase.js';
import { requireUser, createChallenge, findChallenge, updateChallenge, failChallengeAttempt, deleteChallenge, endSession } from '../_lib/session.js';
import { loadAccount, secondFactorRequired } from '../_lib/users.js';
import { listPasskeys, registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { methodsFor, hasSecondFactor, issueBackupCodes, localBackupCount, hasLocalTotp, saveEventsTotp, backupCodesForNewFactor } from '../_lib/factors.js';
import { createLinkToken, linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { forgetAllSubscriptions } from '../_lib/push.js';
import { passkeyView } from '../_lib/serialize.js';
import { LIMITS } from '../_lib/event-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What the Security section of the account page shows, and the passkey ids
// its Remove buttons send.
async function summary(userId) {
  const user = await loadAccount(userId, { auth: true });
  const [passkeys, chat, backupLeft, localTotp] = await Promise.all([
    listPasskeys(userId),
    linkedChat(userId),
    localBackupCount(userId),
    hasLocalTotp(userId),
  ]);
  return {
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

export default route('me/security', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) return;
  const session = await requireUser(request, response);
  if (!session) return;
  const userId = session.user.id;

  if (request.method === 'GET') return ok(response, await summary(userId));

  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'securityWrite', [`u:${userId}`])) return;

  const user = await loadAccount(userId, { auth: true });
  const passwordOk = async () => {
    if (await limited(request, response, 'reauth', [`u:${userId}`])) return null;
    const right = await verifyPassword(body.password, user.password_hash);
    if (!right) fail(response, 401, 'password_wrong');
    return right;
  };
  const mayRemove = async (what) => !secondFactorRequired(user) || (await wouldKeepAFactor(user, what));

  switch (body.action) {
    case 'totp-start': {
      if (user.totp_secret || (await hasLocalTotp(userId))) return fail(response, 409, 'totp_exists');
      if (!(await passwordOk())) return;
      const secret = generateTotpSecret();
      const setup = await createChallenge({ purpose: 'totp-setup', userId });
      // The pending secret waits, encrypted, on the challenge row.
      await updateChallenge(await findChallenge(setup, 'totp-setup'), { pending_totp_secret: encryptSecret(secret) });
      return ok(response, { setup, secret, uri: otpauthUri({ account: user.username, secret }) });
    }
    case 'totp-finish': {
      const challenge = await findChallenge(body.setup, 'totp-setup');
      const secret = challenge && challenge.user_id === userId ? decryptSecret(challenge.pending_totp_secret) : null;
      if (!secret) return fail(response, 400, 'setup_not_started');
      if (!verifyTotp(body.code, secret)) {
        await failChallengeAttempt(challenge);
        return fail(response, 401, 'code_wrong');
      }
      await saveEventsTotp(userId, secret);
      await deleteChallenge(challenge);
      const codes = await backupCodesForNewFactor(user);
      await audit(request, { action: 'security.totp_added', actorId: userId });
      return ok(response, { ...(await summary(userId)), codes });
    }
    case 'totp-remove': {
      if (!(await passwordOk())) return;
      if (!(await mayRemove('totp'))) return fail(response, 409, 'last_factor');
      const { error } = await database().from(TABLES.totp).delete().eq('user_id', userId);
      if (error) throw error;
      await audit(request, { action: 'security.totp_removed', actorId: userId });
      return ok(response, await summary(userId));
    }
    case 'passkey-options': {
      if (!(await passwordOk())) return;
      return ok(response, { options: await registrationOptions(user) });
    }
    case 'passkey-finish': {
      const name = String(body.label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.label) || null;
      const result = await finishRegistration(userId, body.response, name);
      if (!result.ok) return fail(response, 400, result.error);
      await audit(request, { action: 'security.passkey_added', actorId: userId });
      const codes = await backupCodesForNewFactor(user);
      return ok(response, { ...(await summary(userId)), codes });
    }
    case 'passkey-remove': {
      if (!UUID.test(String(body.id ?? ''))) return fail(response, 400, 'bad_request');
      if (!(await passwordOk())) return;
      if (!(await mayRemove('passkey'))) return fail(response, 409, 'last_factor');
      await removePasskey(userId, body.id);
      await audit(request, { action: 'security.passkey_removed', actorId: userId });
      return ok(response, await summary(userId));
    }
    case 'telegram-link': {
      if (!telegramConfigured()) return fail(response, 400, 'telegram_off');
      // Only the link: the page opens it and shows no expiry.
      const { url } = await createLinkToken(userId, null);
      return ok(response, { url });
    }
    case 'telegram-unlink': {
      if (!(await passwordOk())) return;
      if (!(await mayRemove('telegram'))) return fail(response, 409, 'last_factor');
      const { error } = await database().from(TABLES.telegram).delete().eq('user_id', userId);
      if (error) throw error;
      await audit(request, { action: 'security.telegram_unlinked', actorId: userId, details: { via: 'site' } });
      return ok(response, await summary(userId));
    }
    case 'backup-regenerate': {
      if (!(await passwordOk())) return;
      const codes = await issueBackupCodes(userId);
      await audit(request, { action: 'security.backup_codes_issued', actorId: userId });
      return ok(response, { codes });
    }
    case 'delete-account': {
      if (user.kind !== 'public') return fail(response, 403, 'staff_account');
      if (!(await passwordOk())) return;
      // Cascades to sessions, factors, Telegram link and RSVPs; the audit
      // log keeps its rows with the actor set to null.
      await forgetAllSubscriptions(userId);
      const { error } = await database().from(TABLES.accounts).delete().eq('id', userId).eq('kind', 'public');
      if (error) throw error;
      await endSession(request, response);
      return ok(response, { deleted: true });
    }
    default:
      return fail(response, 400, 'bad_request');
  }
});
