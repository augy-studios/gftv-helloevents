// GET  /api/auth/session   -> { signedIn, user? }
// POST /api/auth/session   { action: "logout" }
//                          { action: "logout-others" }  every other session

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { currentSession, endSession, endOtherSessions } from '../_lib/session.js';
import { audit } from '../_lib/guards.js';
import { selfView } from '../_lib/serialize.js';

export default route('auth/session', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    const session = await currentSession(req);
    if (!session) return ok(res, { signedIn: false });
    return ok(res, { signedIn: true, user: selfView(session.user) });
  }

  const body = await readJson(req, res);
  if (!body) return;

  if (body.action === 'logout') {
    const session = await currentSession(req);
    await endSession(req, res);
    if (session) await audit(req, { action: 'auth.signed_out', actorId: session.user.id });
    return ok(res, { signedIn: false });
  }

  if (body.action === 'logout-others') {
    const session = await currentSession(req);
    if (!session) return fail(res, 401, 'signed_out');
    await endOtherSessions(session.user.id, session.sessionId);
    await audit(req, { action: 'auth.signed_out_others', actorId: session.user.id });
    return ok(res, { signedIn: true });
  }

  fail(res, 400, 'bad_request');
});
