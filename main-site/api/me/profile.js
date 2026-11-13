// POST /api/me/profile { displayName }  change a public account's display
// name. Staff names come from gftv.asia and are changed there.
//
// The same rules as sign-up: up to 60 characters, and no listed word
// (name-filter.js). -> { user }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount } from '../_lib/users.js';
import { cleanDisplayName } from '../_lib/account-rules.js';
import { refusedName } from '../_lib/name-filter.js';
import { selfView } from '../_lib/serialize.js';

// Checks the new display name like sign-up does, saves it, and answers with
// the account as the page shows it.
export default route('me/profile', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const user = session.user;
  if (user.kind !== 'public') {
    return fail(response, 403, 'staff_account');
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'securityWrite', [`u:${user.id}`])) {
    return;
  }

  const displayName = cleanDisplayName(body.displayName);
  // The 60 is counted in Unicode code points, not UTF-16 units.
  if (displayName.length < 1 || [...displayName].length > 60) {
    return fail(response, 400, 'display_name_invalid');
  }
  if (await refusedName(displayName)) {
    return fail(response, 400, 'display_name_reserved');
  }

  const { error } = await database()
    .from(TABLES.accounts)
    .update({ display_name: displayName })
    .eq('id', user.id)
    .eq('kind', 'public');
  if (error) {
    throw error;
  }
  await audit(request, { action: 'account.display_name_changed', actorId: user.id });
  const account = await loadAccount(user.id);
  ok(response, { user: selfView(account) });
});
