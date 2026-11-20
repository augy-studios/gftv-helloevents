// Contact details an event asks for (migrations/021, js/contact-fields.js),
// end to end against the in-memory database: what the edit form saves, the
// values people may give, an RSVP needing them as the event's rule says,
// filling them in later, and who sees them.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const rules = await import('../api/_lib/event-rules.js');
const contact = await import('../js/contact-fields.js');
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
  const [user] = (await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@example.com`,
    password_hash: await bcrypt.hash(PASSWORD, 4), is_approved: true, totp_secret: SHARED_SECRET, ...over,
  }).select()).data;
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  b.id = user.id;
  return b;
}

const FIELDS = [{ id: 'phone', type: 'phone', label: null }, { id: 'telegram', type: 'telegram', label: null }, { id: 'cfur123', type: 'text', label: 'Fursona' }];

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(), slug: 'contact-meet', title: 'Contact Meet', status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(), price_type: 'free',
    contact_fields: FIELDS, contact_rule: 'any',
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

const go = (b, body = {}) => b.call(rsvp, { method: 'POST', body: { slug: 'contact-meet', going: true, ...body } });
const stored = (eventId, userId) => db.table('gftvevents_attendees').find((row) => row.event_id === eventId && row.user_id === userId).contact;

test('the edit form saves the fields asked for and the rule, ready-made ones first', () => {
  const form = { title: 'Meet', kind: 'furmeet', description: 'A', descriptionZh: 'B', status: 'published', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'free' };
  const saved = rules.validateEvent({
    ...form,
    contactFields: [{ id: 'cinsta1', type: 'username', label: '  Instagram ' }, { id: 'discord' }, { id: 'phone', type: 'ignored', label: 'ignored' }],
    contactRule: 'all',
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.fields.contact_fields, [
    { id: 'phone', type: 'phone', label: null },
    { id: 'discord', type: 'discord', label: null },
    { id: 'cinsta1', type: 'username', label: 'Instagram' },
  ]);
  assert.equal(saved.fields.contact_rule, 'all');
  // A blank or long label is pointed at; anything else odd is refused.
  const blank = rules.validateEvent({ ...form, contactFields: [{ id: 'phone' }, { id: 'cabc123', type: 'text', label: ' ' }] });
  assert.deepEqual([blank.field, blank.contact], ['contactLabel', 1]);
  assert.equal(rules.validateEvent({ ...form, contactFields: [{ id: 'cabc123', type: 'text', label: 'x'.repeat(41) }] }).field, 'contactLabel');
  assert.equal(rules.validateEvent({ ...form, contactFields: [{ id: 'phone' }, { id: 'phone' }] }).field, 'contactFields');
  assert.equal(rules.validateEvent({ ...form, contactFields: [{ id: 'cabc123', type: 'password', label: 'x' }] }).field, 'contactFields');
  assert.equal(rules.validateEvent({ ...form, contactFields: [{ id: 'evil', type: 'text', label: 'x' }] }).field, 'contactFields');
  assert.equal(rules.validateEvent({ ...form, contactFields: 'phone' }).field, 'contactFields');
  const six = Array.from({ length: 6 }, (unused, index) => ({ id: `cfield${index}`, type: 'text', label: `F${index}` }));
  assert.equal(rules.validateEvent({ ...form, contactFields: six }).field, 'contactFields');
  assert.equal(rules.validateEvent({ ...form, contactFields: [], contactRule: 'some' }).field, 'contactRule');
  assert.equal('contact_fields' in rules.validateEvent(form).fields, false, 'a page from before keeps what is stored');
});

test('each kind of value is checked and stored in one form', () => {
  const value = (type, typed) => contact.contactValue(type, typed);
  assert.deepEqual(value('phone', ' +65 9123-4567 '), { ok: true, value: '+65 9123-4567' });
  assert.equal(value('phone', '12345').ok, false);
  assert.equal(value('phone', 'call me').ok, false);
  assert.deepEqual(value('telegram', '@Otter_Paws'), { ok: true, value: 'Otter_Paws' });
  assert.deepEqual(value('telegram', 'https://t.me/otter_paws'), { ok: true, value: 'otter_paws' });
  for (const bad of ['abc', '1otter', 'otter paws', 'otter_', 'x'.repeat(33)]) {
    assert.equal(value('telegram', bad).ok, false, bad);
  }
  assert.deepEqual(value('discord', '@Fox.Paws'), { ok: true, value: 'fox.paws' });
  assert.deepEqual(value('discord', 'Fox#1234'), { ok: true, value: 'Fox#1234' });
  assert.equal(value('discord', 'fox..paws').ok, false);
  assert.equal(value('discord', 'fox paws').ok, false);
  assert.deepEqual(value('email', 'otter@example.org'), { ok: true, value: 'otter@example.org' });
  assert.equal(value('email', 'otter@example').ok, false);
  assert.equal(value('username', 'two words').ok, false);
  assert.deepEqual(value('text', ' A  river\\notter '.replace('\\n', '\n')), { ok: true, value: 'A river otter' });
  assert.deepEqual(value('phone', ''), { ok: true, value: '' });
  // The rule: at least one, all of them, or none.
  const answer = (rule, given) => contact.readContactAnswers(FIELDS, rule, given);
  assert.deepEqual(answer('any', {}), { ok: false, error: 'contact_required', field: null });
  assert.deepEqual(answer('any', { cfur123: 'Otter' }), { ok: true, contact: { cfur123: 'Otter' } });
  assert.deepEqual(answer('all', { phone: '+65 91234567', cfur123: 'Otter' }), { ok: false, error: 'contact_required', field: 'telegram' });
  assert.deepEqual(answer('optional', {}), { ok: true, contact: {} });
  assert.deepEqual(answer('optional', { phone: 'nope' }), { ok: false, error: 'contact_invalid', field: 'phone' });
  // Values for fields the event does not ask for are dropped.
  assert.deepEqual(answer('any', { telegram: 'otter_paws', password: 'x' }), { ok: true, contact: { telegram: 'otter_paws' } });
  assert.match(contact.newContactId(), /^c[a-z0-9]{6}$/);
});

test('an RSVP needs the contact details the event asks for; editors see them, nobody else', async () => {
  const event = addEvent();
  const otter = await signedIn('otter');
  assert.deepEqual((await go(otter)).json, { ok: false, error: 'contact_required' });
  const invalid = await go(otter, { contact: { phone: 'call me', telegram: 'otter_paws' } });
  assert.deepEqual(invalid.json, { ok: false, error: 'contact_invalid', field: 'phone' });
  assert.equal(db.table('gftvevents_attendees').length, 0, 'nothing is taken until they are right');
  assert.equal((await go(otter, { contact: 'phone' })).json.error, 'bad_request');

  const joined = await go(otter, { contact: { telegram: '@otter_paws', phone: '', smuggled: 'x' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.deepEqual(joined.json.event.viewer.contact, { telegram: 'otter_paws' });
  assert.equal(joined.json.event.viewer.contactMissing, false);
  assert.deepEqual(stored(event.id, otter.id), { telegram: 'otter_paws' });
  // The page shows what is asked, and their own, to them only.
  const page = (await otter.call(detail, { query: { slug: 'contact-meet' } })).json.event;
  assert.deepEqual(page.contact, { fields: FIELDS, rule: 'any' });
  assert.deepEqual(page.viewer.contact, { telegram: 'otter_paws' });
  const stranger = await signedIn('stranger');
  const theirs = (await stranger.call(detail, { query: { slug: 'contact-meet' } })).json;
  assert.deepEqual(theirs.event.viewer.contact, {});
  assert.equal(JSON.stringify(theirs).includes('otter_paws'), false);

  // A change of meals or the like keeps them; sending them changes them.
  assert.deepEqual((await go(otter)).json.event.viewer.contact, { telegram: 'otter_paws' });
  assert.deepEqual((await go(otter, { contact: { cfur123: 'River' } })).json.event.viewer.contact, { cfur123: 'River' });
  assert.equal((await go(otter, { contact: {} })).json.error, 'contact_required');

  // The editor's attendee list names each value.
  const editor = await signedIn('boss', { is_editor: true });
  const list = (await editor.call(manage, { query: { id: event.id } })).json.attendees;
  assert.deepEqual(list.find((each) => each.username === 'otter').contact, [{ id: 'cfur123', type: 'text', label: 'Fursona', value: 'River' }]);
});

test('someone going before the event asked is told, and fills them in on their own', async () => {
  const event = addEvent({ contact_fields: [] });
  const otter = await signedIn('otter');
  assert.equal((await go(otter)).status, 200);
  db.table('gftvevents_events').find((row) => row.id === event.id).contact_fields = FIELDS;
  db.table('gftvevents_events').find((row) => row.id === event.id).contact_rule = 'all';
  const page = (await otter.call(detail, { query: { slug: 'contact-meet' } })).json.event;
  assert.equal(page.viewer.going, true);
  assert.equal(page.viewer.contactMissing, true);

  const only = (body) => otter.call(rsvp, { method: 'POST', body: { slug: 'contact-meet', ...body } });
  const short = await only({ contact: { phone: '+65 9123 4567' } });
  assert.deepEqual(short.json, { ok: false, error: 'contact_required', field: 'telegram' });
  const filled = await only({ contact: { phone: '+65 9123 4567', telegram: 'otter_paws', cfur123: 'River' } });
  assert.equal(filled.status, 200, JSON.stringify(filled.json));
  assert.equal(filled.json.event.viewer.going, true, 'still going, with the same RSVP');
  assert.equal(filled.json.event.viewer.contactMissing, false);
  assert.deepEqual(stored(event.id, otter.id), { phone: '+65 9123 4567', telegram: 'otter_paws', cfur123: 'River' });
  // Someone not going cannot send them on their own.
  const stranger = await signedIn('stranger');
  assert.equal((await stranger.call(rsvp, { method: 'POST', body: { slug: 'contact-meet', contact: { phone: '+65 9123 4567' } } })).json.error, 'not_going');
});

test('the form is filled in from what they gave before, or their linked Telegram', async () => {
  addEvent({ slug: 'first-meet', contact_fields: [{ id: 'discord', type: 'discord', label: null }] });
  addEvent();
  const otter = await signedIn('otter');
  await db.from('gftvevents_telegram_links').insert({ user_id: otter.id, chat_id: 42, telegram_username: 'otter_linked' });
  assert.equal((await otter.call(rsvp, { method: 'POST', body: { slug: 'first-meet', going: true, contact: { discord: 'otter.fox' } } })).status, 200);
  // Discord's is not asked here; phone was never given; Telegram comes from the link.
  const page = (await otter.call(detail, { query: { slug: 'contact-meet' } })).json.event;
  assert.deepEqual(page.viewer.contact, { telegram: 'otter_linked' });
  addEvent({ slug: 'third-meet', contact_fields: [{ id: 'discord', type: 'discord', label: null }, { id: 'telegram', type: 'telegram', label: null }] });
  const third = (await otter.call(detail, { query: { slug: 'third-meet' } })).json.event;
  assert.deepEqual(third.viewer.contact, { discord: 'otter.fox', telegram: 'otter_linked' });
});

test('a ticket from the checkout page carries the contact details too', async () => {
  addEvent({ price_type: 'paid', price_min: 20, currency: 'SGD', payment_methods: ['link'], payment_link: 'https://pay.example.com/meet', contact_rule: 'all', contact_fields: [{ id: 'phone', type: 'phone', label: null }] });
  const otter = await signedIn('otter');
  const page = (await otter.call(checkout, { query: { slug: 'contact-meet' } })).json.checkout;
  assert.deepEqual(page.contact, { fields: [{ id: 'phone', type: 'phone', label: null }], rule: 'all' });
  assert.equal((await go(otter, { payment: { method: 'link' } })).json.error, 'contact_required');
  const bought = await go(otter, { payment: { method: 'link' }, contact: { phone: '+65 9123 4567' } });
  assert.equal(bought.status, 200, JSON.stringify(bought.json));
  assert.deepEqual((await otter.call(checkout, { query: { slug: 'contact-meet' } })).json.checkout.viewer.contact, { phone: '+65 9123 4567' });
});
