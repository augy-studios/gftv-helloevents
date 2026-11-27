// HelloID reviews (migrations/027), for GFTV's admins on /manage's "ID
// reviews" tab: the checks HelloID could not clear on its own.
//
// GET                              -> { reviews }  oldest first
// GET ?check=<id>&photo=id|selfie  the ID photo (front and back) or the
//                                  selfie of a check waiting for review;
//                                  never cached, admins only
// POST { action: "approve", check }          -> { reviews }
// POST { action: "decline", check, reason }  -> { reviews }
//        the person is told either way (push and Telegram); a declined
//        person can try again. The photos are deleted once decided.
//
// A review: the person (name, username), when they sent it, the document
// (country and type), the legal name and date of birth it is for and
// whether the account already had them, and what the checks found (each
// check, the passport's name and date of birth, the device, and whether the
// face or device verified another account). Never an email or an id other
// than the check's own.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { readPaymentFile } from '../_lib/payments.js';
import { helloidById, pendingHelloids, decideHelloid } from '../_lib/helloid-checks.js';
import { background, sendHelloidDecision } from '../_lib/notify.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return value;
}

function reviewView(row) {
  let account = row.account;
  if (!account) {
    account = {};
  }
  let person = account;
  if (account.kind === 'staff') {
    person = account.staff;
    if (!person) {
      person = {};
    }
  }
  let displayName = person.display_name;
  if (!displayName) {
    displayName = person.username;
  }
  let findings = row.findings;
  if (!findings || typeof findings !== 'object') {
    findings = {};
  }
  return {
    check: row.id,
    username: textOrNull(person.username),
    displayName: textOrNull(displayName),
    staff: account.kind === 'staff',
    submittedAt: row.submitted_at,
    legalName: textOrNull(row.verified_name),
    dateOfBirth: textOrNull(row.verified_birth),
    accountHadName: Boolean(account.legal_name),
    findings,
    idPhotoUrl: `/api/manage/helloid?check=${row.id}&photo=id`,
    selfieUrl: `/api/manage/helloid?check=${row.id}&photo=selfie`,
  };
}

async function reviews() {
  return (await pendingHelloids()).map(reviewView);
}

async function photo(response, checkId, which) {
  response.setHeader('Cache-Control', 'no-store, private');
  const check = await helloidById(checkId);
  if (!check || check.status !== 'pending') {
    return fail(response, 404, 'not_found');
  }
  let path = check.selfie_path;
  if (which === 'id') {
    path = check.id_photo_path;
  }
  const file = await readPaymentFile(path);
  if (!file) {
    return fail(response, 404, 'not_found');
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', file.type);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(file.bytes);
}

export default route('manage/helloid', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { admin: true });
  if (!session) {
    return;
  }
  const user = session.user;
  if (request.method === 'GET') {
    const checkId = query(request, 'check');
    if (checkId) {
      const which = query(request, 'photo');
      if (!UUID_PATTERN.test(checkId) || !['id', 'selfie'].includes(which)) {
        return fail(response, 400, 'bad_request');
      }
      return photo(response, checkId.toLowerCase(), which);
    }
    return ok(response, { reviews: await reviews() });
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'manageWrite', [`u:${user.id}`])) {
    return;
  }
  if (!['approve', 'decline'].includes(body.action) || !UUID_PATTERN.test(String(body.check))) {
    return fail(response, 400, 'bad_request');
  }
  const approved = body.action === 'approve';
  let reason = null;
  if (!approved) {
    let typed = '';
    if (typeof body.reason === 'string') {
      typed = body.reason;
    }
    reason = typed.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!reason) {
      return fail(response, 400, 'helloid_reason_required');
    }
  }
  const check = await helloidById(String(body.check).toLowerCase());
  if (!check || check.status !== 'pending') {
    return fail(response, 409, 'helloid_not_pending');
  }
  const decided = await decideHelloid(check, { approved, reviewerId: user.id, reason });
  if (!decided) {
    return fail(response, 409, 'helloid_not_pending');
  }
  await audit(request, { action: `admin.helloid_${body.action}d`, actorId: user.id, details: { check: check.id } });
  background(sendHelloidDecision(check.account_id, approved));
  return ok(response, { reviews: await reviews() });
});
