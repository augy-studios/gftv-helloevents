// POST /api/auth/login  { identifier, password, humanCheck? }
//
// Step one of signing in, against gftvhello_users. Never issues a session.
//
//   -> { challenge, step: "verify", methods }  the account has a second
//      factor; /api/auth/verify takes it from here.
//   -> { challenge, step: "setup", options }   the account has none yet, so it
//      must set one up before it gets in; /api/auth/enrol takes it from here.
//
// The same answer, invalid_credentials, for an unknown account and a wrong
// password, and the unknown-account branch costs a real bcrypt comparison.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { verifyPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';
import { createChallenge } from '../_lib/session.js';
import { findUserForLogin, canSignIn } from '../_lib/users.js';
import { methodsFor, hasSecondFactor } from '../_lib/factors.js';
import { telegramConfigured } from '../_lib/telegram.js';

export default route('auth/login', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;

  const identifier = String(body.identifier ?? '').trim().toLowerCase();
  if (await limited(req, res, 'login', [`id:${sha256(identifier)}`])) return;
  if (await refusedForTurnstile(req, res, body.humanCheck, 'login')) return;

  const user = await findUserForLogin(identifier);
  const passwordOk = await verifyPassword(body.password, user?.password_hash);
  if (!user || !passwordOk) {
    if (user) await audit(req, { action: 'auth.password_failed', actorId: user.id });
    return fail(res, 401, 'invalid_credentials');
  }
  if (!canSignIn(user)) {
    await audit(req, { action: 'auth.denied', actorId: user.id, details: { reason: 'not_approved' } });
    return fail(res, 403, 'no_access');
  }

  const methods = await methodsFor(user);
  if (hasSecondFactor(methods)) {
    const challenge = await createChallenge({ purpose: 'login', userId: user.id });
    return ok(res, { challenge, step: 'verify', methods });
  }

  // No second factor anywhere yet: the mandatory set-up step.
  const challenge = await createChallenge({ purpose: 'enrol', userId: user.id });
  await audit(req, { action: 'auth.setup_started', actorId: user.id });
  ok(res, {
    challenge,
    step: 'setup',
    options: { totp: true, passkey: true, telegram: telegramConfigured() },
  });
});
