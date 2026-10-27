// POST /api/me/profile { displayName }  change a public account's display
// name. Staff names come from gftv.asia and are changed there.
//
// The same rules as sign-up: up to 60 characters, and no listed word
// (name-filter.js). -> { user }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount } from '../_lib/users.js';
import { cleanDisplayName } from '../_lib/account-rules.js';
import { refusedName } from '../_lib/name-filter.js';
import { selfView } from '../_lib/serialize.js';

export default route('me/profile', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const session = await requireUser(req, res);
  if (!session) return;
  const user = session.user;
  if (user.kind !== 'public') return fail(res, 403, 'staff_account');
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'securityWrite', [`u:${user.id}`])) return;

  const displayName = cleanDisplayName(body.displayName);
  if (displayName.length < 1 || [...displayName].length > 60) return fail(res, 400, 'display_name_invalid');
  if (await refusedName(displayName)) return fail(res, 400, 'display_name_reserved');

  const { error } = await db().from(T.accounts).update({ display_name: displayName }).eq('id', user.id).eq('kind', 'public');
  if (error) throw error;
  await audit(req, { action: 'account.display_name_changed', actorId: user.id });
  ok(res, { user: selfView(await loadAccount(user.id)) });
});
