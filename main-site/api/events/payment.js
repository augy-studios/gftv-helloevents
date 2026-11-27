// POST /api/events/payment   (migrations/016)
//   { slug, action: "report", reference, proof? }   I have paid
//   { slug, action: "method", method }               pay another way instead
//   { slug, action: "upgrade", tier, tierName, method }  upgrade to a dearer tier
//
// For someone holding a ticket from /checkout that is not confirmed paid yet.
//
// report: after paying by link or QR code (the admins' chats are told,
// staff-alerts.js), a screenshot of the payment (a
// WebP the browser made, js/picture-file.js; payments.js checks and
// re-encodes it), which is needed (payment_proof_required), and, if they
// like, its reference (as the bank or app shows it). The payment then
// waits for an editor to check it ("submitted"). Reporting again replaces
// the reference, and the screenshot when a new one is sent (the one sent
// before is kept otherwise).
//
// method: another of the ways the event offers. Paying on the day turns the
// ticket into a plain RSVP; link or QR code waits for payment again. What
// was reported so far is dropped, screenshot and all. The amount stays.
//
// upgrade (migrations/024): swaps the dearest tier held (one of) for a
// dearer one still sold (event-rules.js upgradeOptions), paid by method
// (one the new tiers share). What was paid so far is kept as credit, and
// only the difference is owed: the order waits for payment again (or is
// paid on the day). Not to a tier with no places left (migrations/025:
// tier_full). A paid ticket can be upgraded; one whose reported
// payment waits for a check cannot, nor once registration has closed for
// the person (RSVPs closed, the event over, or their tier closed).
//
// -> { checkout } as api/events/checkout.js answers.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { attendance, withVolunteerSource, withTierCounts, volunteerStanding } from '../_lib/events.js';
import { ticketOptions, readPaymentReference, registrationOpenFor, upgradeBasket, paidSoFar, ONLINE_METHODS } from '../_lib/event-rules.js';
import { preparePicture, storeProof, deletePaymentFiles, MAX_PROOF_BYTES } from '../_lib/payments.js';
import { checkoutEvent, checkoutAnswer } from './checkout.js';
import { background } from '../_lib/notify.js';
import { alertPaymentReported } from '../_lib/staff-alerts.js';

const MAX_BODY_BYTES = Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 4096;

async function writePayment(eventId, userId, columns) {
  const { error } = await database()
    .from(TABLES.attendees)
    .update(columns)
    .eq('event_id', eventId)
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
}

// "report": a screenshot of the payment (needed: it is what shows they
// paid), and its reference if they like.
async function report(request, response, event, user, stored, body) {
  if (!ONLINE_METHODS.includes(stored.payment_method)) {
    return fail(response, 400, 'payment_not_online');
  }
  const typed = readPaymentReference(body.reference);
  if (!typed.ok) {
    return fail(response, 400, 'payment_reference_invalid');
  }
  let proofSent = false;
  if (body.proof !== undefined && body.proof !== null) {
    proofSent = true;
  }
  // Reporting again may keep the screenshot already sent.
  if (!proofSent && !stored.payment_proof_path) {
    return fail(response, 400, 'payment_proof_required');
  }
  let proofPath = stored.payment_proof_path;
  if (proofSent) {
    const prepared = await preparePicture(body.proof, 'proof');
    if (!prepared.ok) {
      return fail(response, 400, prepared.error);
    }
    proofPath = await storeProof(event.id, user.id, prepared.buffer);
  }
  try {
    await writePayment(event.id, user.id, {
      payment_status: 'submitted',
      payment_reference: typed.reference,
      payment_proof_path: proofPath,
      payment_submitted_at: new Date().toISOString(),
    });
  } catch (cause) {
    if (proofPath !== stored.payment_proof_path) {
      await deletePaymentFiles([proofPath]);
    }
    throw cause;
  }
  if (proofPath !== stored.payment_proof_path) {
    await deletePaymentFiles([stored.payment_proof_path]);
  }
  await audit(request, { action: 'payment.reported', actorId: user.id, eventId: event.id, details: { proof: Boolean(proofPath) } });
  // The admins' chats, to check it; once, not again for a report replaced
  // while it waits.
  if (stored.payment_status !== 'submitted') {
    background(alertPaymentReported(event, user.id));
  }
  return ok(response, { checkout: await checkoutAnswer(event, user) });
}

// "method": another way to pay.
async function switchMethod(request, response, event, user, stored, body) {
  if (!ticketOptions(event, stored).includes(body.method)) {
    return fail(response, 400, 'payment_method_required');
  }
  if (!stored.payment_method) {
    return fail(response, 400, 'payment_not_online');
  }
  let status = 'none';
  if (ONLINE_METHODS.includes(body.method)) {
    status = 'awaiting';
  }
  await writePayment(event.id, user.id, {
    payment_method: body.method,
    payment_status: status,
    payment_reference: null,
    payment_proof_path: null,
    payment_submitted_at: null,
  });
  await deletePaymentFiles([stored.payment_proof_path]);
  await audit(request, { action: 'payment.method_changed', actorId: user.id, eventId: event.id, details: { method: body.method } });
  return ok(response, { checkout: await checkoutAnswer(event, user) });
}

// "upgrade": a dearer tier, paying only the difference.
async function upgrade(request, response, event, user, stored, body) {
  if (!registrationOpenFor(event, stored)) {
    return fail(response, 409, 'registration_closed');
  }
  if (stored.payment_status === 'submitted') {
    return fail(response, 409, 'payment_pending_check');
  }
  if (!stored.payment_method) {
    return fail(response, 400, 'upgrade_unavailable');
  }
  await withVolunteerSource(event);
  await withTierCounts(event);
  const standing = await volunteerStanding(event, user.id);
  const priced = upgradeBasket(event, stored, body.tier, body.tierName, { volunteerDiscount: standing.discount });
  if (!priced.ok) {
    return fail(response, 400, priced.error);
  }
  if (!priced.methods.includes(body.method)) {
    return fail(response, 400, 'payment_method_required');
  }
  const credit = paidSoFar(stored);
  let status = 'none';
  if (ONLINE_METHODS.includes(body.method)) {
    status = 'awaiting';
  }
  if (priced.due <= 0 && stored.payment_status === 'paid') {
    status = 'paid';
  }
  let creditKept = null;
  if (credit > 0) {
    creditKept = credit;
  }
  const columns = {
    payment_method: body.method,
    payment_status: status,
    payment_tier: priced.text,
    payment_items: priced.items,
    payment_amount: priced.amount,
    payment_currency: priced.currency,
    payment_credit: creditKept,
    payment_reference: null,
    payment_proof_path: null,
    payment_submitted_at: null,
  };
  if (status !== 'paid') {
    columns.paid_at = null;
    columns.paid_by = null;
  }
  // The new tier takes its place first, under the event's lock, so it is
  // held to its limit (migrations/025).
  const { data: taken, error } = await database().rpc('gftvevents_take_tiers', { p_event_id: event.id, p_user_id: user.id, p_items: priced.items });
  if (error) {
    throw error;
  }
  if (String(taken) === 'tier_full') {
    return fail(response, 409, 'tier_full');
  }
  if (String(taken) !== 'ok') {
    return fail(response, 404, 'not_going');
  }
  await writePayment(event.id, user.id, columns);
  await deletePaymentFiles([stored.payment_proof_path]);
  await audit(request, { action: 'payment.upgraded', actorId: user.id, eventId: event.id, details: { from: stored.payment_tier, to: priced.text, amount: priced.amount, credit } });
  return ok(response, { checkout: await checkoutAnswer(event, user) });
}

export default route('events/payment', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const body = await readJson(request, response, { maxBytes: MAX_BODY_BYTES });
  if (!body) {
    return;
  }
  if (await limited(request, response, 'payment', [`u:${session.user.id}`])) {
    return;
  }
  let typedSlug = '';
  if (typeof body.slug === 'string') {
    typedSlug = body.slug;
  }
  const event = await checkoutEvent(typedSlug.toLowerCase(), session.user);
  if (!event) {
    return fail(response, 404, 'not_found');
  }
  const mine = await attendance(event.id, session.user.id);
  if (!mine.going || !mine.payment) {
    return fail(response, 404, 'not_going');
  }
  if (body.action === 'upgrade') {
    await upgrade(request, response, event, session.user, mine.payment, body);
    return;
  }
  if (mine.payment.payment_status === 'paid') {
    return fail(response, 409, 'payment_confirmed');
  }
  if (body.action === 'report') {
    await report(request, response, event, session.user, mine.payment, body);
    return;
  }
  if (body.action === 'method') {
    await switchMethod(request, response, event, session.user, mine.payment, body);
    return;
  }
  fail(response, 400, 'bad_request');
});
