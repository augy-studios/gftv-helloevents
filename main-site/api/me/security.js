// The signed-in person's second factors on this site.
//
// GET                                         -> summary (below)
// POST { action: "passkey-options", password } -> { options }
// POST { action: "passkey-finish", response, label? }
// POST { action: "passkey-remove", id, password }
// POST { action: "telegram-link" }             -> { url, expiresInMinutes }
// POST { action: "telegram-unlink", password }
// POST { action: "backup-regenerate", password } -> { codes }
//
// The GFTV password is asked for again before anything that adds or removes
// a way in. Removing the last second factor is refused: the account would be
// back at the set-up gate, protected by its password alone.
//
// The authenticator app set up on gftv.asia is shown but not changed here;
// that lives with the shared account.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { verifyPassword } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { db, T } from '../_lib/supabase.js';
import { requireUser } from '../_lib/session.js';
import { findUserById, USER_AUTH_COLUMNS } from '../_lib/users.js';
import { listPasskeys, registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { methodsFor, hasSecondFactor, issueBackupCodes, localBackupCount, hasLocalTotp } from '../_lib/factors.js';
import { createLinkToken, linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { passkeyView } from '../_lib/serialize.js';
import { LIMITS } from '../_lib/event-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function summary(userId) {
  const user = await findUserById(userId, USER_AUTH_COLUMNS);
  const [passkeys, chat, backupLeft, localTotp] = await Promise.all([
    listPasskeys(userId),
    linkedChat(userId),
    localBackupCount(userId),
    hasLocalTotp(userId),
  ]);
  return {
    totp: { shared: Boolean(user?.totp_secret), local: localTotp },
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
  if (without === 'passkey') {
    const left = (await listPasskeys(user.id)).length - 1;
    methods.passkey = left > 0;
  }
  return hasSecondFactor(methods);
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

  const user = await findUserById(userId, USER_AUTH_COLUMNS);
  const passwordOk = async () => {
    if (await limited(req, res, 'reauth', [`u:${userId}`])) return null;
    const right = await verifyPassword(body.password, user.password_hash);
    if (!right) fail(res, 401, 'password_wrong');
    return right;
  };

  switch (body.action) {
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
      if (!(await wouldKeepAFactor(user, 'passkey'))) return fail(res, 409, 'last_factor');
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
      if (!(await wouldKeepAFactor(user, 'telegram'))) return fail(res, 409, 'last_factor');
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
    default:
      return fail(res, 400, 'bad_request');
  }
});
