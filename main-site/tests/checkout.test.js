// Checkout and payment methods (migrations/016), end to end against the
// in-memory database: which methods an event can offer, what a ticket costs,
// reserving a place by link or QR code, reporting a payment with a
// screenshot, an editor confirming it, and the pictures kept private and
// tidied away.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const rules = await import('../api/_lib/event-rules.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const detail = await route('events/detail');
const rsvp = await route('events/rsvp');
const checkout = await route('events/checkout');
const payment = await route('events/payment');
const paymentQr = await route('events/payment-qr');
const manage = await route('manage/events');
const uploadQr = await route('manage/payment-qr');
const proofRoute = await route('manage/payment-proof');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
});

async function signedIn(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username,
    display_name: username,
    email: `${username}@example.com`,
    password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true,
    totp_secret: SHARED_SECRET,
    ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return b;
}

const QR_PATH = `qr/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/abcdefghijklmnopqrstuv.png`;

// A paid event taking payment by link and QR code (and on the day), with
// two ticket tiers, its QR code already in the bucket.
function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'paid-con',
    title: 'Paid Con',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    description: 'About.',
    description_zh: '关于。',
    price_type: 'paid',
    currency: 'SGD',
    tiers_enabled: true,
    ticket_tiers: [
      { name: 'Day pass', price: 40, benefits: ['Entry'], includes_previous: false, previous_display: 'reference' },
      { name: 'Sponsor', price: 120, benefits: ['A badge'], includes_previous: true, previous_display: 'reference' },
    ],
    price_min: 40,
    price_max: 120,
    payment_methods: ['onsite', 'link', 'qr'],
    payment_link: 'https://pay.example.com/paid-con',
    payment_qr_path: QR_PATH,
    payment_instructions: 'Put your RSVP ID in the reference.',
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  db.objects.set(`gftvevents_payments/${QR_PATH}`, { body: Buffer.from('png'), contentType: 'image/png' });
  return row;
}

const picture = (width, height, format) => sharp({ create: { width, height, channels: 3, background: '#336699' } })[format]().toBuffer();
const base64 = (buffer) => buffer.toString('base64');

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

test('the edit form saves the payment methods, link and instructions, never refusing a tick', () => {
  const form = { title: 'Meet', kind: 'furmeet', description: 'A', descriptionZh: 'B', status: 'published', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'paid', priceMin: '10', currency: 'SGD' };
  const saved = rules.validateEvent({ ...form, paymentMethods: ['qr', 'onsite', 'qr'], paymentLink: '', paymentInstructions: ' Pay to Fox ' });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.fields.payment_methods, ['onsite', 'qr']);
  assert.equal(saved.fields.payment_link, null);
  assert.equal(saved.fields.payment_instructions, 'Pay to Fox');
  assert.equal(rules.validateEvent({ ...form, paymentMethods: ['cash'] }).field, 'paymentMethods');
  assert.equal(rules.validateEvent({ ...form, paymentLink: 'http://pay.example.com' }).field, 'paymentLink');
  // A page from before checkout keeps what is stored.
  assert.equal('payment_methods' in rules.validateEvent(form).fields, false);
});

test('a method is offered only once it can be used, and checkout only for link or QR code', () => {
  const base = { price_type: 'paid', price_min: 10, price_max: null, payment_methods: ['onsite', 'link', 'qr'], payment_link: null, payment_qr_path: null };
  assert.deepEqual(rules.paymentOptions(base), ['onsite']);
  assert.equal(rules.needsCheckout(base), false);
  assert.deepEqual(rules.paymentProblems(base), ['no_link', 'no_qr']);
  const ready = { ...base, payment_link: 'https://pay.example.com', payment_qr_path: QR_PATH };
  assert.deepEqual(rules.paymentOptions(ready), ['onsite', 'link', 'qr']);
  assert.equal(rules.needsCheckout(ready), true);
  // A range with no tiers has no one amount to pay.
  const range = { ...ready, price_max: 30 };
  assert.deepEqual(rules.paymentOptions(range), ['onsite']);
  assert.deepEqual(rules.paymentProblems(range), ['no_single_price']);
  // A free event takes no payment at all.
  assert.deepEqual(rules.paymentOptions({ ...ready, price_type: 'free' }), []);
  assert.deepEqual(rules.paymentProblems({ ...ready, price_type: 'free' }), ['not_paid']);
});

test('a ticket costs its tier, less any volunteer benefit', () => {
  const row = addEvent();
  assert.deepEqual(rules.ticketPrice(row, { tierIndex: 1, tierName: 'Sponsor' }), { ok: true, tier: 'Sponsor', price: 120, amount: 120, discount: 0 });
  assert.equal(rules.ticketPrice(row, { tierIndex: 1, tierName: 'Day pass' }).error, 'tier_changed');
  assert.equal(rules.ticketPrice(row, {}).error, 'tier_required');
  const con = { ...row, kind: 'convention', volunteer_discount_enabled: true, volunteer_discount_from: crypto.randomUUID(), volunteer_discount_type: 'percent', volunteer_discount_value: 25 };
  assert.equal(rules.ticketPrice(con, { tierIndex: 0, tierName: 'Day pass', volunteerDiscount: true }).amount, 30);
  const flat = { ...con, volunteer_discount_type: 'amount', volunteer_discount_value: 50 };
  assert.equal(rules.ticketPrice(flat, { tierIndex: 0, tierName: 'Day pass', volunteerDiscount: true }).amount, 0);
});

// ---------------------------------------------------------------------------
// Getting a ticket
// ---------------------------------------------------------------------------

test('a ticket by QR code reserves a place, then the QR code and report follow', async () => {
  const event = addEvent({ capacity: 1 });
  const buyer = await signedIn('buyer');

  // The event page says a ticket goes through checkout.
  const page = await buyer.call(detail, { query: { slug: 'paid-con' } });
  assert.deepEqual(page.json.event.payment, { checkout: true, methods: ['onsite', 'link', 'qr'] });
  assert.deepEqual(page.json.event.viewer.payment, { method: null, status: 'none' });

  // Checkout before reserving: prices shown, no link or QR code yet.
  let view = (await buyer.call(checkout, { query: { slug: 'paid-con' } })).json.checkout;
  assert.deepEqual(view.tickets.map((ticket) => [ticket.index, ticket.name, ticket.amount]), [[0, 'Day pass', 40], [1, 'Sponsor', 120]]);
  assert.equal(view.paymentLink, null);
  assert.equal(view.paymentQrUrl, null);

  // A plain RSVP is refused: the ticket needs a method and a tier.
  assert.equal((await buyer.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true } })).json.error, 'payment_method_required');
  const reserved = await buyer.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true, payment: { method: 'qr', tier: 1, tierName: 'Sponsor' } } });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.json));
  assert.deepEqual(reserved.json.event.viewer.payment, { method: 'qr', status: 'awaiting' });
  const row = db.table('gftvevents_attendees').find((each) => each.event_id === event.id);
  assert.equal(row.payment_amount, 120);
  assert.equal(row.payment_tier, 'Sponsor');

  // The place is held: the event (one space) is now full.
  const other = await signedIn('other');
  const full = await other.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true, payment: { method: 'onsite', tier: 0, tierName: 'Day pass' } } });
  assert.equal(full.json.error, 'event_full');

  // Now the QR code, and only for this buyer.
  view = (await buyer.call(checkout, { query: { slug: 'paid-con' } })).json.checkout;
  assert.match(view.paymentQrUrl, /^\/api\/events\/payment-qr\?slug=paid-con&v=/);
  assert.equal(view.paymentLink, null);
  const v = new URL(view.paymentQrUrl, 'https://x').searchParams.get('v');
  const qr = await buyer.call(paymentQr, { query: { slug: 'paid-con', v } });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers['cache-control'], 'private, max-age=3600');
  assert.equal((await other.call(paymentQr, { query: { slug: 'paid-con', v } })).status, 404);

  // Reporting it: a reference is needed; a screenshot is kept, privately.
  assert.equal((await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'report', reference: '' } })).json.error, 'payment_reference_required');
  const proof = base64(await picture(900, 1600, 'webp'));
  const reported = await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'report', reference: 'TXN 123', proof } });
  assert.equal(reported.status, 200, JSON.stringify(reported.json));
  assert.equal(reported.json.checkout.viewer.payment.status, 'submitted');
  assert.equal(reported.json.checkout.viewer.payment.hasProof, true);
  const firstProof = row.payment_proof_path;
  assert.match(firstProof, /^proof\//);
  assert.equal(db.objects.has(`gftvevents_payments/${firstProof}`), true);
  // A new screenshot replaces the old one.
  await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'report', reference: 'TXN 124', proof } });
  assert.equal(db.objects.has(`gftvevents_payments/${firstProof}`), false);
  assert.equal(db.objects.has(`gftvevents_payments/${row.payment_proof_path}`), true);

  // A picture that is not a WebP is refused.
  const png = base64(await picture(200, 200, 'png'));
  assert.equal((await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'report', reference: 'X', proof: png } })).json.error, 'proof_invalid');

  // Taking the RSVP back deletes the screenshot.
  const proofKey = `gftvevents_payments/${row.payment_proof_path}`;
  await buyer.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: false } });
  assert.equal(db.objects.has(proofKey), false);
});

test('an editor sees the payment and screenshot, and ticks Paid (or takes it back)', async () => {
  addEvent();
  const buyer = await signedIn('buyer');
  const editor = await signedIn('editor', { is_editor: true });
  await buyer.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true, payment: { method: 'link', tier: 0, tierName: 'Day pass' } } });
  const view = (await buyer.call(checkout, { query: { slug: 'paid-con' } })).json.checkout;
  assert.equal(view.paymentLink, 'https://pay.example.com/paid-con');
  assert.equal(view.paymentQrUrl, null);
  await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'report', reference: 'PAY-9', proof: base64(await picture(400, 800, 'webp')) } });

  const event = db.table('gftvevents_events').find((each) => each.slug === 'paid-con');
  const list = (await editor.call(manage, { query: { id: event.id } })).json.attendees;
  assert.deepEqual(list[0].payment, {
    method: 'link', status: 'submitted', tier: 'Day pass', amount: 40, currency: 'SGD', reference: 'PAY-9', hasProof: true,
    submittedAt: list[0].payment.submittedAt, paidAt: null,
  });

  // The screenshot: editors only, never cached.
  const shot = await editor.call(proofRoute, { query: { id: event.id, username: 'buyer', staff: '1' } });
  assert.equal(shot.status, 200);
  assert.equal(shot.headers['cache-control'], 'private, no-store');
  assert.equal((await buyer.call(proofRoute, { query: { id: event.id, username: 'buyer', staff: '1' } })).status, 403);

  const paid = await editor.call(manage, { method: 'POST', body: { action: 'payment-confirm', id: event.id, username: 'buyer', staff: true, paid: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.equal(paid.json.attendees[0].payment.status, 'paid');
  // Once paid, the buyer cannot change it.
  const late = await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'method', method: 'qr' } });
  assert.equal(late.json.error, 'payment_confirmed');
  // Taken back: waiting for a check again, as a reference was given.
  const undone = await editor.call(manage, { method: 'POST', body: { action: 'payment-confirm', id: event.id, username: 'buyer', staff: true, paid: false } });
  assert.equal(undone.json.attendees[0].payment.status, 'submitted');
});

test('pay on the day is a plain RSVP, a meal needs no payment, and switching methods resets the report', async () => {
  addEvent({ meal_options: [{ id: 'lunch' }] });
  const buyer = await signedIn('buyer');
  const onsite = await buyer.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true, payment: { method: 'onsite', tier: 0, tierName: 'Day pass' } } });
  assert.deepEqual(onsite.json.event.viewer.payment, { method: 'onsite', status: 'none' });
  // Changing to QR code waits for payment.
  const switched = await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'method', method: 'qr' } });
  assert.equal(switched.json.checkout.viewer.payment.status, 'awaiting');
  assert.equal((await buyer.call(payment, { method: 'POST', body: { slug: 'paid-con', action: 'method', method: 'cash' } })).json.error, 'payment_method_required');
  // Going just for lunch: nothing to pay, and the unpaid ticket is dropped.
  const meal = await buyer.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true, meals: ['lunch'] } });
  assert.equal(meal.status, 200, JSON.stringify(meal.json));
  assert.deepEqual(meal.json.event.viewer.payment, { method: null, status: 'none' });

  // Someone else, just for lunch from the start: no method asked.
  const diner = await signedIn('diner');
  assert.equal((await diner.call(rsvp, { method: 'POST', body: { slug: 'paid-con', going: true, meals: ['lunch'] } })).status, 200);
});

test('an editor uploads a QR code of any shape, kept as a PNG, and replacing it deletes the old one', async () => {
  const event = addEvent({ payment_qr_path: null });
  const editor = await signedIn('editor', { is_editor: true });
  const before = (await editor.call(manage, { query: { id: event.id } })).json.event;
  assert.deepEqual(before.paymentProblems, ['no_qr']);
  // A tall, narrow picture: no crop, no fixed shape.
  const tall = base64(await picture(300, 900, 'png'));
  const up = await editor.call(uploadQr, { method: 'POST', body: { id: event.id, image: tall } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.match(up.json.event.paymentQrUrl, /payment-qr\?slug=paid-con&v=/);
  assert.deepEqual(up.json.event.paymentProblems, []);
  const stored = db.table('gftvevents_events').find((each) => each.id === event.id).payment_qr_path;
  const meta = await sharp(db.objects.get(`gftvevents_payments/${stored}`).body).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 300, 900]);

  // Too small, or not a PNG.
  assert.equal((await editor.call(uploadQr, { method: 'POST', body: { id: event.id, image: base64(await picture(20, 20, 'png')) } })).json.error, 'qr_size');
  assert.equal((await editor.call(uploadQr, { method: 'POST', body: { id: event.id, image: base64(await picture(200, 200, 'webp')) } })).json.error, 'qr_invalid');

  await editor.call(uploadQr, { method: 'POST', body: { id: event.id, remove: true } });
  assert.equal(db.objects.has(`gftvevents_payments/${stored}`), false);
  // A member cannot upload one.
  const member = await signedIn('member');
  assert.equal((await member.call(uploadQr, { method: 'POST', body: { id: event.id, image: tall } })).status, 403);
});
