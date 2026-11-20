// "Just Lepak Only" (migrations/017), end to end against the in-memory
// database: what the edit form saves, coming to a paid event without a
// ticket (no space taken, no checkout), with meals, within its own cap, and
// leaving a ticket for it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
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
const manage = await route('manage/events');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
});

async function signedIn(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@example.com`,
    password_hash: await bcrypt.hash(PASSWORD, 4), is_approved: true, totp_secret: SHARED_SECRET, ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return b;
}

// A paid event with one space, taking payment by link (so a ticket goes
// through checkout), lunch on offer, and lepak RSVPs capped at two.
function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(), slug: 'lepak-meet', title: 'Lepak Meet', status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    price_type: 'paid', price_min: 20, currency: 'SGD', capacity: 1,
    payment_methods: ['link'], payment_link: 'https://pay.example.com/lepak',
    meal_options: [{ id: 'lunch' }],
    lepak_enabled: true, lepak_limit: 2, lepak_label: null,
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

const go = (b, body) => b.call(rsvp, { method: 'POST', body: { slug: 'lepak-meet', going: true, ...body } });

test('the edit form saves lepak, its words and its cap; it is offered only on a paid event', () => {
  const form = { title: 'Meet', kind: 'furmeet', description: 'A', descriptionZh: 'B', status: 'published', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'paid', priceMin: '10', currency: 'SGD' };
  const saved = rules.validateEvent({ ...form, lepakEnabled: true, lepakLabel: ' Just chill ', lepakLimit: '5' });
  assert.equal(saved.ok, true);
  assert.deepEqual([saved.fields.lepak_enabled, saved.fields.lepak_label, saved.fields.lepak_limit], [true, 'Just chill', 5]);
  assert.equal(rules.validateEvent({ ...form, lepakEnabled: true, lepakLimit: '0' }).field, 'lepakLimit');
  assert.equal(rules.validateEvent({ ...form, lepakLabel: 'x'.repeat(41) }).field, 'lepakLabel');
  assert.equal('lepak_enabled' in rules.validateEvent(form).fields, false, 'a page from before lepak keeps what is stored');
  assert.equal(rules.lepakOffered({ lepak_enabled: true, price_type: 'paid' }), true);
  assert.equal(rules.lepakOffered({ lepak_enabled: true, price_type: 'free' }), false);
  assert.equal(rules.lepakLabel({ lepak_label: null }), 'Just Lepak Only');
});

test('lepak needs no ticket or checkout, takes no space, can add meals, and has its own cap', async () => {
  const event = addEvent();
  const page = (await (await signedIn('looker')).call(detail, { query: { slug: 'lepak-meet' } })).json.event;
  assert.deepEqual(page.lepak, { offered: true, label: 'Just Lepak Only', limit: 2, left: 2 });

  // The one space goes to a ticket holder.
  const buyer = await signedIn('buyer');
  assert.equal((await go(buyer, { payment: { method: 'link' } })).status, 200);
  const full = await signedIn('late');
  assert.equal((await go(full, { payment: { method: 'link' } })).json.error, 'event_full');

  // Lepak still gets in, with no payment asked, and lunch too.
  const chill = await signedIn('chill');
  const joined = await go(chill, { lepak: true, meals: ['lunch'] });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.equal(joined.json.event.viewer.lepak, true);
  assert.deepEqual(joined.json.event.viewer.payment, { method: null, status: 'none' });
  assert.equal(joined.json.event.going, 1, 'lepak is not counted in the spaces');
  assert.equal(joined.json.event.lepak.left, 1);
  // Insiders' details, as for anyone going.
  assert.equal(joined.json.event.viewer.going, true);

  // The cap: one more, then full.
  assert.equal((await go(full, { lepak: true })).status, 200);
  const third = await signedIn('third');
  assert.equal((await go(third, { lepak: true })).json.error, 'lepak_full');

  // Leaving lunch keeps lepak; an RSVP sent without lepak would turn it off.
  const kept = await go(chill, { lepak: true, meals: [] });
  assert.equal(kept.json.event.viewer.lepak, true);
  assert.deepEqual(kept.json.event.viewer.meals, []);

  // Editors see who is lepak.
  const editor = await signedIn('editor', { is_editor: true });
  const list = (await editor.call(manage, { query: { id: event.id } })).json.attendees;
  assert.deepEqual(list.filter((each) => each.lepak).map((each) => each.username).sort(), ['chill', 'late']);
  const form = (await editor.call(manage, { query: { id: event.id } })).json.event;
  assert.deepEqual([form.lepakEnabled, form.lepakLimit, form.lepakLabel], [true, '2', '']);
});

test('a ticket waiting for payment is dropped for lepak; lepak is refused on a free event', async () => {
  addEvent({ capacity: null });
  const buyer = await signedIn('buyer');
  await go(buyer, { payment: { method: 'link' } });
  const switched = await go(buyer, { lepak: true });
  assert.equal(switched.status, 200, JSON.stringify(switched.json));
  assert.deepEqual(switched.json.event.viewer.payment, { method: null, status: 'none' });
  // Back to the whole event: a ticket again, through checkout.
  assert.equal((await go(buyer, {})).json.error, 'payment_method_required');
  const view = (await buyer.call(checkout, { query: { slug: 'lepak-meet' } })).json.checkout;
  assert.equal(view.viewer.withoutTicket, true);

  db.table('gftvevents_events')[0].price_type = 'free';
  const someone = await signedIn('someone');
  assert.equal((await go(someone, { lepak: true })).json.error, 'lepak_not_offered');
});
