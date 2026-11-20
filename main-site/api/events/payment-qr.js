// GET /api/events/payment-qr?slug=<slug>&v=<QR code name>   (migrations/016)
//
// An event's payment QR code, as the editor uploaded it (a PNG, any shape;
// payments.js). It goes only to editors (the edit form shows it) and to
// someone signed in holding a ticket for the event paid by QR code, as the
// checkout page shows it; anyone else gets 404. Never kept by a shared
// cache; the browser may keep it a while, as v changes with every upload.

import { route, guard, fail, query } from '../_lib/http.js';
import { currentSession } from '../_lib/session.js';
import { canManage } from '../_lib/users.js';
import { anyEventBySlug, attendance } from '../_lib/events.js';
import { qrVersion, readPaymentFile } from '../_lib/payments.js';

const COLUMNS = 'id, slug, payment_qr_path';

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

// Whether this session may see the event's QR code.
async function maySee(session, row) {
  if (!session) {
    return false;
  }
  if (canManage(session.user)) {
    return true;
  }
  const mine = await attendance(row.id, session.user.id);
  if (!mine.payment || mine.payment.payment_method !== 'qr') {
    return false;
  }
  return mine.payment.payment_status !== 'none';
}

export default route('events/payment-qr', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const version = query(request, 'v');
  const row = await anyEventBySlug(slug, COLUMNS);
  if (!row || !version || qrVersion(row.payment_qr_path) !== version) {
    return notFound(response);
  }
  const session = await currentSession(request);
  if (!(await maySee(session, row))) {
    return notFound(response);
  }
  const file = await readPaymentFile(row.payment_qr_path);
  if (!file) {
    return notFound(response);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', file.type);
  response.setHeader('Content-Length', String(file.bytes.length));
  response.setHeader('Cache-Control', 'private, max-age=3600');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(file.bytes);
});
