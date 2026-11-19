// POST /api/me/profile { displayName?, country? }  change the profile:
//   displayName  a public account's display name. Staff names come from
//                gftv.asia and are changed there. The same rules as sign-up:
//                up to 60 characters, and no listed word (name-filter.js).
//   country      the country of origin (migrations/015), a two-letter code
//                from the pages' country list. Any account, staff included;
//                a cross-border event needs one to RSVP. It can be changed
//                but not emptied.
// -> { user }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount, ensureStaffAccount } from '../_lib/users.js';
import { cleanDisplayName } from '../_lib/account-rules.js';
import { countryCode } from '../_lib/countries.js';
import { refusedName } from '../_lib/name-filter.js';
import { selfView } from '../_lib/serialize.js';

// The new display name, checked like sign-up does: { ok: true, value } or
// { ok: false, response sent }.
async function checkedDisplayName(response, user, typed) {
  if (user.kind !== 'public') {
    fail(response, 403, 'staff_account');
    return { ok: false };
  }
  const displayName = cleanDisplayName(typed);
  // The 60 is counted in Unicode code points, not UTF-16 units.
  if (displayName.length < 1 || [...displayName].length > 60) {
    fail(response, 400, 'display_name_invalid');
    return { ok: false };
  }
  if (await refusedName(displayName)) {
    fail(response, 400, 'display_name_reserved');
    return { ok: false };
  }
  return { ok: true, value: displayName };
}

// Checks what was sent, saves it, and answers with the account as the page
// shows it.
export default route('me/profile', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const user = session.user;
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'securityWrite', [`u:${user.id}`])) {
    return;
  }
  if (body.displayName === undefined && body.country === undefined) {
    return fail(response, 400, 'bad_request');
  }

  const changes = {};
  if (body.displayName !== undefined) {
    const name = await checkedDisplayName(response, user, body.displayName);
    if (!name.ok) {
      return;
    }
    changes.display_name = name.value;
  }
  if (body.country !== undefined) {
    const country = countryCode(body.country);
    if (!country) {
      return fail(response, 400, 'country_required');
    }
    changes.country = country;
  }

  // A staff member's accounts row may not exist yet; it is made first.
  if (user.kind === 'staff') {
    await ensureStaffAccount(user.id);
  }
  const { error } = await database()
    .from(TABLES.accounts)
    .update(changes)
    .eq('id', user.id)
    .eq('kind', user.kind);
  if (error) {
    throw error;
  }
  if (changes.display_name) {
    await audit(request, { action: 'account.display_name_changed', actorId: user.id });
  }
  if (changes.country) {
    await audit(request, { action: 'account.country_changed', actorId: user.id, details: { country: changes.country } });
  }
  const account = await loadAccount(user.id);
  ok(response, { user: selfView(account) });
});
