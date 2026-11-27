// POST /api/idcheck/webhook?provider=didit|veriff
//
// An ID provider telling us a check has a result (migrations/027,
// id-checks.js): a decision that came after the person left its page, such
// as a manual review. Set this address as the webhook in each provider's
// dashboard (SETUP.md).
//
// The provider's signature is checked first (each in its own way, with its
// own webhook secret), and a request that fails it gets 401. Even a signed
// body is only a pointer: it names the provider's session, and the result
// is read from the provider's own API (refreshCheck), never taken from the
// body. Veriff signs the exact bytes sent; when the runtime has already
// parsed the body and the bytes are gone, Didit's second signature (over
// sorted JSON) still works, and Veriff's is refused, so its decisions then
// arrive when the person comes back, or with "Check again".
//
// Answers 200 to anything signed, known or not, so the provider does not
// retry for a session this site never started.

import { route, readRawJson, send, query } from '../_lib/http.js';
import { limited } from '../_lib/guards.js';
import { isProvider, providerWebhook, checkBySession, refreshCheck } from '../_lib/id-checks.js';

export default route('idcheck/webhook', async (request, response) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { ok: false });
  }
  const provider = query(request, 'provider');
  if (!isProvider(provider)) {
    return send(response, 404, { ok: false });
  }
  if (await limited(request, response, 'idWebhook', [`provider:${provider}`])) {
    return;
  }
  const { raw, parsed } = await readRawJson(request, { maxBytes: 1024 * 1024 });
  const signed = providerWebhook(provider).webhookSessionId(request.headers, raw, parsed);
  if (!signed.ok) {
    return send(response, 401, { ok: false });
  }
  if (signed.sessionId) {
    const check = await checkBySession(provider, signed.sessionId);
    if (check) {
      await refreshCheck(check);
    }
  }
  return send(response, 200, { ok: true });
});
