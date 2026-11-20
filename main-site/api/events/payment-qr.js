// GET /api/events/payment-qr?slug=<slug>&v=<QR code name>   (migrations/016)
//
// An event's payment QR code, or one of its ticket tiers' own, as the editor
// uploaded it (a PNG, any shape; payments.js). It goes only to editors (the
// edit form shows it) and to someone signed in holding a ticket for the
// event paid by QR code, and then only the QR code for their ticket's tier
// (its own, or the event's), as the checkout page shows it; anyone else gets
// 404. Never kept by a shared cache; the browser may keep it a while, as v
// changes with every upload.

import { route, guard, fail, query } from '../_lib/http.js';
import { currentSession } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { anyEventBySlug, attendance } from '../_lib/events.js';
import { qrVersion, readPaymentFile } from '../_lib/payments.js';
import { storedTiers, tierNamed, tierQrPath } from '../_lib/event-rules.js';

const COLUMNS = 'id, slug, payment_qr_path, tiers_enabled, ticket_tiers';

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

// The stored QR code this address names: the event's, or a tier's.
function pathFor(row, version) {
  const paths = [row.payment_qr_path, ...storedTiers(row).map((tier) => tier.payment_qr_path)];
  const match = paths.find((path) => {
    if (!path) {
      return false;
    }
    return qrVersion(path) === version;
  });
  if (!match) {
    return null;
  }
  return match;
}

// Whether this session may see that QR code.
async function maySee(session, row, path) {
  if (!session) {
    return false;
  }
  if (await canEditEvent(session.user, row.id)) {
    return true;
  }
  const mine = await attendance(row.id, session.user.id);
  if (!mine.payment || mine.payment.payment_method !== 'qr' || mine.payment.payment_status === 'none') {
    return false;
  }
  return tierQrPath(row, tierNamed(row, mine.payment.payment_tier)) === path;
}

export default route('events/payment-qr', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const version = query(request, 'v');
  const row = await anyEventBySlug(slug, COLUMNS);
  if (!row || !version) {
    return notFound(response);
  }
  const path = pathFor(row, version);
  if (!path) {
    return notFound(response);
  }
  const session = await currentSession(request);
  if (!(await maySee(session, row, path))) {
    return notFound(response);
  }
  const file = await readPaymentFile(path);
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
