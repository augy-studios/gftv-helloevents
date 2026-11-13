// POST /api/auth/login  { identifier, password, "cf-turnstile-response"? }
//
// Step one of signing in, for both kinds of account (users.js): a staff
// account on gftvhello_users, or a public account made on this site.
//
//   -> { challenge, step: "verify", methods }  a second factor is set up;
//      /api/auth/verify takes it from here. No session yet.
//   -> { step: "done" }                        a public account with no
//      second factor: 2FA is optional for those, so the password is enough.
//      The page goes on to the next one, which asks /api/auth/session who
//      is signed in, so no account details come back here.
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

export default route('auth/login', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;

  const identifier = String(body.identifier ?? '').trim().toLowerCase();
  if (await limited(request, response, 'login', [`id:${sha256(identifier)}`])) return;
  if (await refusedForTurnstile(request, response, body, 'login')) return;

  const { staff, member } = await findForLogin(identifier);
  const [staffOk, memberOk] = await Promise.all([
    verifyPassword(body.password, staff?.password_hash),
    verifyPassword(body.password, member?.password_hash),
  ]);
  // A staff account wins if both somehow match (sign-up refuses staff names
  // and emails, so that would be a public account made before the staff one).
  const account = staffOk ? staff : memberOk ? member : null;
  if (!account) {
    for (const who of [staff, member]) if (who) await audit(request, { action: 'auth.password_failed', actorId: who.kind === 'public' ? who.id : null, details: { kind: who.kind } });
    return fail(response, 401, 'invalid_credentials');
  }
  if (!canSignIn(account)) {
    await audit(request, { action: 'auth.denied', actorId: account.kind === 'public' ? account.id : null, details: { kind: account.kind, reason: 'not_allowed' } });
    return fail(response, 403, account.kind === 'staff' ? 'no_access' : 'account_suspended');
  }

  const methods = await methodsFor(account);
  if (hasSecondFactor(methods, account)) {
    const challenge = await createChallenge({ purpose: 'login', userId: account.id, account });
    return ok(response, { challenge, step: 'verify', methods });
  }

  if (secondFactorRequired(account)) {
    await audit(request, { action: 'auth.denied', details: { kind: 'staff', reason: 'no_second_factor' } });
    return fail(response, 403, 'staff_needs_2fa');
  }

  // A public account without 2FA: the password is the whole sign-in.
  await createSession(request, response, account, 'password');
  await audit(request, { action: 'auth.signed_in', actorId: account.id, details: { method: 'password' } });
  ok(response, { step: 'done' });
});
