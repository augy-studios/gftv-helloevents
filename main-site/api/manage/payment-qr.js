// POST /api/manage/payment-qr { id, image }        set an event's payment QR code
// POST /api/manage/payment-qr { id, remove: true } take it off
//
// Editors and admins only (migrations/016). image is a base64 PNG the browser
// drew from the picture chosen (js/picture-file.js), at its own shape: no
// crop, no fixed aspect ratio. payments.js checks it and re-encodes it as a
// PNG (lossless, so it still scans) into the private gftvevents_payments
// bucket. The old one is deleted once the event points at the new one.
// -> { event: { paymentQrUrl, paymentProblems } } (serialize.js
// managedPaymentQr), all the edit form redraws.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { managedPaymentQr } from '../_lib/serialize.js';
import { preparePicture, storeQr, deletePaymentFiles, MAX_QR_BYTES } from '../_lib/payments.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = Math.ceil((MAX_QR_BYTES * 4) / 3) + 4096;
// What paymentProblems needs to say why a method cannot be offered yet.
const COLUMNS = 'id, slug, price_type, price_min, price_max, tiers_enabled, ticket_tiers, payment_methods, payment_link, payment_qr_path';

export default route('manage/payment-qr', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true });
  if (!session) {
    return;
  }
  if (await limited(request, response, 'payment', [`u:${session.user.id}`])) {
    return;
  }
  const body = await readJson(request, response, { maxBytes: MAX_BODY_BYTES });
  if (!body) {
    return;
  }
  if (!UUID_PATTERN.test(String(body.id))) {
    return fail(response, 400, 'bad_request');
  }
  const { data: event, error } = await database().from(TABLES.events).select(COLUMNS).eq('id', body.id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!event) {
    return fail(response, 404, 'not_found');
  }

  let path = null;
  let bytes = 0;
  if (body.remove !== true) {
    const prepared = await preparePicture(body.image, 'qr');
    if (!prepared.ok) {
      return fail(response, 400, prepared.error);
    }
    bytes = prepared.buffer.length;
    path = await storeQr(event.id, prepared.buffer);
  }
  const { data: saved, error: saveError } = await database()
    .from(TABLES.events)
    .update({ payment_qr_path: path, updated_by: session.user.id })
    .eq('id', event.id)
    .select(COLUMNS)
    .single();
  if (saveError) {
    await deletePaymentFiles([path]);
    throw saveError;
  }
  await deletePaymentFiles([event.payment_qr_path]);
  let action = 'event.payment_qr_removed';
  if (path) {
    action = 'event.payment_qr_set';
  }
  await audit(request, { action, actorId: session.user.id, eventId: event.id, details: { bytes } });
  ok(response, { event: managedPaymentQr(saved) });
});
