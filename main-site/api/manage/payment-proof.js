// GET /api/manage/payment-proof?id=<event id>&username=<username>&staff=<0|1>
//
// The payment screenshot someone sent with their payment (migrations/016),
// for an editor checking it. Editors and admins only; only someone on that
// event's attendee list, by username (and staff or not, as the list says).
// Never cached anywhere: it is personal.

import { route, guard, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireUser } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { readPaymentFile } from '../_lib/payments.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The username on an attendee row's account, staff or public.
function usernameOf(account) {
  if (!account) {
    return null;
  }
  if (account.kind === 'staff') {
    if (account.staff) {
      return account.staff.username;
    }
    return null;
  }
  return account.username;
}

function notFound(response) {
  response.setHeader('Cache-Control', 'no-store');
  return fail(response, 404, 'not_found');
}

export default route('manage/payment-proof', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  const eventId = query(request, 'id');
  const username = query(request, 'username').trim();
  const staff = query(request, 'staff') === '1';
  if (!UUID_PATTERN.test(eventId) || !username) {
    return notFound(response);
  }
  // An editor of one event (migrations/018): only its own attendees.
  if (!(await canEditEvent(session.user, eventId.toLowerCase()))) {
    return notFound(response);
  }
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`payment_proof_path, account:${TABLES.accounts}!user_id ( kind, username, staff:${TABLES.users} ( username ) )`)
    .eq('event_id', eventId)
    .not('payment_proof_path', 'is', null);
  if (error) {
    throw error;
  }
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  }
  const match = rows.find((row) => {
    if (!row.account || usernameOf(row.account) !== username) {
      return false;
    }
    return (row.account.kind === 'staff') === staff;
  });
  if (!match) {
    return notFound(response);
  }
  const file = await readPaymentFile(match.payment_proof_path);
  if (!file) {
    return notFound(response);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', file.type);
  response.setHeader('Content-Length', String(file.bytes.length));
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(file.bytes);
});
