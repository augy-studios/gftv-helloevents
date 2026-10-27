// POST /api/auth/login  { identifier, password, "cf-turnstile-response"? }
//
// Step one of signing in, for both kinds of account (users.js): a staff
// account on gftvhello_users, or a public account made on this site.
//
//   -> { challenge, step: "verify", methods }  a second factor is set up;
//      /api/auth/verify takes it from here. No session yet.
//   -> { step: "done", user }                  a public account with no
//      second factor: 2FA is optional for those, so the password is enough.
//
// A staff account with no second factor is refused with staff_needs_2fa and
// told to set an authenticator up on gftv.asia first, as OneLink GFTV does.
// This site never sets a first factor up for a staff account.
//
// The same answer, invalid_credentials, for an unknown account and a wrong
// password. Both lookups always cost a bcrypt comparison, real or dummy, so
// the time taken does not say which kind of account a name belongs to.
//
// Turnstile (action "login", turnstile.js) runs after the rate limit and
// before any account is looked up.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { verifyPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';
import { createChallenge, createSession } from '../_lib/session.js';
import { findForLogin, canSignIn, secondFactorRequired } from '../_lib/users.js';
import { methodsFor, hasSecondFactor } from '../_lib/factors.js';
import { selfView } from '../_lib/serialize.js';

export default route('auth/login', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;

  const identifier = String(body.identifier ?? '').trim().toLowerCase();
  if (await limited(req, res, 'login', [`id:${sha256(identifier)}`])) return;
  if (await refusedForTurnstile(req, res, body, 'login')) return;

  const { staff, member } = await findForLogin(identifier);
  const [staffOk, memberOk] = await Promise.all([
    verifyPassword(body.password, staff?.password_hash),
    verifyPassword(body.password, member?.password_hash),
  ]);
  // A staff account wins if both somehow match (sign-up refuses staff names
  // and emails, so that would be a public account made before the staff one).
  const account = staffOk ? staff : memberOk ? member : null;
  if (!account) {
    for (const who of [staff, member]) if (who) await audit(req, { action: 'auth.password_failed', actorId: who.kind === 'public' ? who.id : null, details: { kind: who.kind } });
    return fail(res, 401, 'invalid_credentials');
  }
  if (!canSignIn(account)) {
    await audit(req, { action: 'auth.denied', actorId: account.kind === 'public' ? account.id : null, details: { kind: account.kind, reason: 'not_allowed' } });
    return fail(res, 403, account.kind === 'staff' ? 'no_access' : 'account_suspended');
  }

  const methods = await methodsFor(account);
  if (hasSecondFactor(methods, account)) {
    const challenge = await createChallenge({ purpose: 'login', userId: account.id, account });
    return ok(res, { challenge, step: 'verify', methods });
  }

  if (secondFactorRequired(account)) {
    await audit(req, { action: 'auth.denied', details: { kind: 'staff', reason: 'no_second_factor' } });
    return fail(res, 403, 'staff_needs_2fa');
  }

  // A public account without 2FA: the password is the whole sign-in.
  await createSession(req, res, account, 'password');
  await audit(req, { action: 'auth.signed_in', actorId: account.id, details: { method: 'password' } });
  ok(res, { step: 'done', user: selfView(account) });
});
