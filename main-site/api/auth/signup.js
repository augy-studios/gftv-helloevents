// POST /api/auth/signup { username, displayName, email, password, agree, humanCheck? }
//
// A public account, for RSVPs and notifications. Signs the new account in
// straight away (2FA is optional for public accounts; the account page
// offers it). -> { user }
//
// Protected by Turnstile (action "signup", when the keys are set) and rate
// limits on the connection and the email. Usernames and emails already used
// by a staff account on gftv.asia are refused too, so nobody can sign up as
// someone on the team. The password is bcrypt, cost 12 (crypto.js).
//
// No email is sent: there is no email sender yet, so the address is not
// verified. It is used to sign in, and never shown to anyone else.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { hashPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';
import { createSession } from '../_lib/session.js';
import { identityTaken, loadAccount } from '../_lib/users.js';
import { validateSignup } from '../_lib/account-rules.js';
import { selfView } from '../_lib/serialize.js';

export default route('auth/signup', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'signup', [`email:${sha256(String(body.email ?? '').trim().toLowerCase())}`])) return;
  if (await refusedForTurnstile(req, res, body.humanCheck, 'signup')) return;

  const check = validateSignup(body);
  if (!check.ok) return fail(res, 400, check.error);
  const { username, displayName, email } = check.fields;

  const taken = await identityTaken({ username, email });
  if (taken) return fail(res, 409, taken);

  const now = new Date().toISOString();
  const { data, error } = await db()
    .from(T.accounts)
    .insert({
      kind: 'public',
      username,
      display_name: displayName,
      email,
      password_hash: await hashPassword(body.password),
      terms_accepted_at: now,
      password_changed_at: now,
    })
    .select('id')
    .single();
  if (error) {
    // Two sign-ups racing for the same name or address.
    if (error.code === '23505') return fail(res, 409, String(error.message).includes('email') ? 'email_taken' : 'username_taken');
    throw error;
  }

  const account = await loadAccount(data.id);
  await createSession(req, res, account, 'password');
  await audit(req, { action: 'account.created', actorId: account.id });
  ok(res, { user: selfView(account) });
});
