// GET  /api/auth/session   -> { signedIn, user? }
// POST /api/auth/session   { action: "logout" }
//                          { action: "logout-others" }  every other session

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { currentSession, endSession, endOtherSessions } from '../_lib/session.js';
import { audit } from '../_lib/guards.js';
import { selfView } from '../_lib/serialize.js';

// GET says who is signed in; POST signs this device, or every other one, out.
export default route('auth/session', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }

  if (request.method === 'GET') {
    const session = await currentSession(request);
    if (!session) {
      return ok(response, { signedIn: false });
    }
    return ok(response, { signedIn: true, user: selfView(session.user) });
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }

  if (body.action === 'logout') {
    const session = await currentSession(request);
    await endSession(request, response);
    if (session) {
      await audit(request, { action: 'auth.signed_out', actorId: session.user.id });
    }
    return ok(response, { signedIn: false });
  }

  if (body.action === 'logout-others') {
    const session = await currentSession(request);
    if (!session) {
      return fail(response, 401, 'signed_out');
    }
    await endOtherSessions(session.user.id, session.sessionId);
    await audit(request, { action: 'auth.signed_out_others', actorId: session.user.id });
    return ok(response, { signedIn: true });
  }

  fail(response, 400, 'bad_request');
});
