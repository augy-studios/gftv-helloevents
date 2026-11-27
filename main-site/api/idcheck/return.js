// GET /api/idcheck/return?next=/e/<slug>&id=<check id>
//
// Where an ID provider sends the person back once they finish or stop
// (migrations/027, id-checks.js). It reads the check's result from the
// provider, then sends the browser on to the account page's Profile tab
// (with the event to go back to), which shows how the check stands.
//
// The session cookie is SameSite=Strict, so it is not sent on this
// navigation from the provider's site: nothing here needs it. The check id
// is a random UUID only its own account and its provider know, and reading
// a result again only stores what the provider says, so anyone holding the
// id can do no more than the provider's webhook does. The id is read from
// the start of its value, in case a provider adds "?..." of its own after
// it, and next is checked to be an event page.

import { route, guard, query } from '../_lib/http.js';
import { limited } from '../_lib/guards.js';
import { checkById, refreshCheck } from '../_lib/id-checks.js';

const ID_AT_START = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const NEXT_PATTERN = /^\/e\/[a-z0-9-]{3,60}$/;

function redirect(response, location) {
  response.statusCode = 303;
  response.setHeader('Location', location);
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}

export default route('idcheck/return', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  let target = '/account?idcheck=done';
  const next = query(request, 'next');
  if (NEXT_PATTERN.test(next)) {
    target += `&next=${encodeURIComponent(next)}`;
  }
  target += '#profile';
  const match = ID_AT_START.exec(query(request, 'id'));
  if (!match) {
    return redirect(response, target);
  }
  if (await limited(request, response, 'idCheckRead', [`check:${match[1].toLowerCase()}`])) {
    return;
  }
  const check = await checkById(match[1].toLowerCase());
  if (check) {
    await refreshCheck(check);
  }
  return redirect(response, target);
});
