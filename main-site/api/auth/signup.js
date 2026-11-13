// POST /api/auth/signup { username, displayName, email, password, agree, "cf-turnstile-response"? }
//
// A public account, for RSVPs and notifications. Signs the new account in
// straight away (2FA is optional for public accounts; the account page
// offers it). Answers only ok: the page moves on to the account page, which
// asks /api/auth/session who is signed in.
//
// Protected by Turnstile (action "signup", turnstile.js) and rate
// limits on the connection and the email. The connection limit is 5 an hour,
// or what a staff member set for it in /manage ("venue mode", a sign-up
// allowance for one connection for a few hours; migrations/003).
//
// Usernames and emails already used by a staff account on gftv.asia are
// refused, and so are usernames and display names that contain a listed
// word (name-filter.js: staff, official, GFTV and look-alikes, plus the
// admins' own list), so nobody can sign up looking like the team.
// The password is bcrypt, cost 12 (crypto.js).
//
// No email is sent: there is no email sender yet, so the address is not
// verified. It is used to sign in, and never shown to anyone else.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { hashPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit, signupAllowance } from '../_lib/guards.js';
import { refusedName } from '../_lib/name-filter.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';
import { createSession } from '../_lib/session.js';
import { identityTaken, loadAccount } from '../_lib/users.js';
import { validateSignup } from '../_lib/account-rules.js';

// Checks the limits, Turnstile and the form, makes the public account, and
// signs it in.
export default route('auth/signup', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  // A staff member's sign-up allowance raises the connection's limit.
  const allowance = await signupAllowance(request);
  let typedEmail = '';
  if (body.email !== null && body.email !== undefined) {
    typedEmail = body.email;
  }
  const subjects = [`email:${sha256(String(typedEmail).trim().toLowerCase())}`];
  let limitOptions = {};
  if (allowance) {
    limitOptions = { max: allowance.max_per_hour };
  }
  if (await limited(request, response, 'signup', subjects, limitOptions)) {
    return;
  }
  if (await refusedForTurnstile(request, response, body, 'signup')) {
    return;
  }

  const check = validateSignup(body);
  if (!check.ok) {
    return fail(response, 400, check.error);
  }
  const { username, displayName, email } = check.fields;
  if (await refusedName(username)) {
    return fail(response, 400, 'username_reserved');
  }
  if (await refusedName(displayName)) {
    return fail(response, 400, 'display_name_reserved');
  }

  const taken = await identityTaken({ username, email });
  if (taken) {
    return fail(response, 409, taken);
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(body.password);
  const { data, error } = await database()
    .from(TABLES.accounts)
    .insert({
      kind: 'public',
      username,
      display_name: displayName,
      email,
      password_hash: passwordHash,
      terms_accepted_at: now,
      password_changed_at: now,
    })
    .select('id')
    .single();
  if (error) {
    // Two sign-ups racing for the same name or address.
    if (error.code === '23505') {
      let takenCode = 'username_taken';
      if (String(error.message).includes('email')) {
        takenCode = 'email_taken';
      }
      return fail(response, 409, takenCode);
    }
    throw error;
  }

  const account = await loadAccount(data.id);
  await createSession(request, response, account, 'password');
  let auditDetails = {};
  if (allowance) {
    auditDetails = { allowance: allowance.id };
  }
  await audit(request, { action: 'account.created', actorId: account.id, details: auditDetails });
  ok(response);
});
