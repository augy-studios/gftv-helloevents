// The account page's ID check (migrations/027, api/_lib/id-checks.js).
//
// GET  -> { idCheck }   the providers this site offers, those the account has
//                       passed with, and its latest check
// POST { action: "start", provider, next? } -> { url }
//        starts a check with a provider this site offers, and answers with
//        the provider's page to send the person to. next: the event page
//        (/e/<slug>) to come back to once it is done.
// POST { action: "refresh" } -> { idCheck }
//        reads the latest check's result from its provider again ("Check
//        again", for a decision that took a while).
//
// idCheck: { providers: [offered], verified: [passed with], latest: null or
// { provider, status, failure } }. status: started, pending (not finished
// at the provider), review (waiting for the provider's decision), approved,
// declined (failure 'document_used': the document already checked another
// account) or failed (expired or abandoned).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount } from '../_lib/users.js';
import { configuredProviders, startCheck, latestCheck, refreshCheck, checkView } from '../_lib/id-checks.js';

const NEXT_PATTERN = /^\/e\/[a-z0-9-]{3,60}$/;

// What the account page shows. user: the account as now stored.
export async function idCheckAnswer(user, latest) {
  return {
    providers: configuredProviders(),
    verified: user.idVerified,
    latest: checkView(latest),
  };
}

export default route('me/idcheck', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const user = session.user;
  if (request.method === 'GET') {
    return ok(response, { idCheck: await idCheckAnswer(user, await latestCheck(user.id)) });
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }

  if (body.action === 'start') {
    if (await limited(request, response, 'idCheck', [`u:${user.id}`])) {
      return;
    }
    if (!configuredProviders().includes(body.provider)) {
      return fail(response, 400, 'id_provider_unavailable');
    }
    let next = '';
    if (typeof body.next === 'string' && NEXT_PATTERN.test(body.next)) {
      next = body.next;
    }
    let started;
    try {
      started = await startCheck(user, body.provider, next);
    } catch (cause) {
      console.error('[helloevents] id check start:', body.provider, String(cause));
      return fail(response, 502, 'id_provider_failed');
    }
    await audit(request, { action: 'idcheck.started', actorId: user.id, details: { provider: body.provider } });
    return ok(response, { url: started.url });
  }

  if (body.action === 'refresh') {
    if (await limited(request, response, 'idCheckRead', [`u:${user.id}`])) {
      return;
    }
    let latest = await latestCheck(user.id);
    if (latest) {
      latest = await refreshCheck(latest);
    }
    const fresh = await loadAccount(user.id);
    let shown = user;
    if (fresh) {
      shown = fresh;
    }
    return ok(response, { idCheck: await idCheckAnswer(shown, latest) });
  }

  return fail(response, 400, 'bad_request');
});
