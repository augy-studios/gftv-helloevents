// Registration forms (migrations/024), end to end against the in-memory
// database: the questions an editor picks, answering them with an RSVP or a
// ticket, the account details a form needs, photos, a donation on top of a
// ticket, changing answers until registration closes (for the event or a
// tier), upgrading to a dearer tier and paying the difference, questions
// asked only of some tiers, and the personal details on the account, locked
// once set.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const rules = await import('../api/_lib/event-rules.js');
const reg = await import('../js/registration-fields.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const detail = await route('events/detail');
const rsvp = await route('events/rsvp');
const checkout = await route('events/checkout');
const payment = await route('events/payment');
const photo = await route('events/registration-photo');
const manage = await route('manage/events');
const admin = await route('manage/admin');
const profile = await route('me/profile');

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

// A con with a short registration form: a badge name, fursuiting, a
// T-shirt size, an optional photo, a donation and the Code of Conduct.
const FORM = [
  { id: 'badgeName', required: true },
  { id: 'fursuiting', required: true },
  { id: 'badgePhoto', required: false },
  { id: 'tshirt', required: true, options: ['S', 'M', 'L'] },
  { id: 'donation' },
  { id: 'conduct', link: 'https://example.com/coc' },
];

// A paid con (only a paid event asks a form) taking plain RSVPs: no way to
// pay is set up, so nobody goes through checkout.
function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'mega-con',
    title: 'Mega Con',
    kind: 'convention',
    status: 'published',
    price_type: 'paid',
    currency: 'SGD',
    starts_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    description: 'About.',
    description_zh: '关于。',
    registration_enabled: true,
    registration_fields: reg.readRegistrationFields(FORM).fields,
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

// The same con selling tiers through checkout, by payment link.
function addPaidEvent(over = {}) {
  return addEvent({
    price_type: 'paid',
    currency: 'SGD',
    tiers_enabled: true,
    ticket_tiers: [
      { name: 'Attendee', price: 60, benefits: ['Entry'], previous_display: 'reference' },
      { name: 'Sponsor', price: 175, benefits: ['A shirt'], previous_display: 'reference' },
    ],
    price_min: 60,
    price_max: 175,
    payment_methods: ['link'],
    payment_link: 'https://pay.example.com/mega-con',
    ...over,
  });
}

const ANSWERS = { badgeName: 'Augy', fursuiting: 'no', tshirt: 'S', conduct: true };
const webp = (width, height) => sharp({ create: { width, height, channels: 3, background: '#33aa66' } }).webp().toBuffer();

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

test('a new form starts with the ready-made questions, and the editor can change them', () => {
  const defaults = reg.defaultRegistrationFields().map((field) => field.id);
  assert.deepEqual(defaults, ['badgeName', 'nfcUrl', 'fursuiting', 'handlers', 'badgePhoto', 'tshirt', 'guardian', 'donation', 'conduct']);
  // Questions of the editor's own go between the ready-made ones and the
  // donation and Code of Conduct, whatever order they were sent in.
  const read = reg.readRegistrationFields([
    { id: 'conduct' },
    { id: 'qroom01', type: 'choice', label: ' Room ', options: ['Single', 'Shared', 'Single'] },
    { id: 'legalName', required: true },
    { id: 'guardian', required: true },
  ]);
  assert.equal(read.ok, true);
  assert.deepEqual(read.fields.map((field) => field.id), ['legalName', 'guardian', 'qroom01', 'conduct']);
  assert.deepEqual(read.fields[2].options, ['Single', 'Shared']);
  assert.equal(read.fields[2].label, 'Room');
  assert.equal(read.fields[1].required, false, 'ticking "accompanying a minor" is never required');
  assert.equal(read.fields[3].required, true, 'the Code of Conduct always is');
  assert.equal(reg.readRegistrationFields([{ id: 'qroom01', type: 'choice', label: 'Room', options: ['One'] }]).field, 'registrationOptions');
  assert.equal(reg.readRegistrationFields([{ id: 'qroom01', type: 'text', label: '' }]).field, 'registrationLabel');
  assert.equal(reg.readRegistrationFields([{ id: 'conduct', link: 'http://example.com' }]).field, 'registrationLink');
  assert.equal(reg.readRegistrationFields([{ id: 'nope' }]).field, 'registrationFields');

  // Saved with the event; a form from before keeps what is stored.
  const form = { title: 'Con', kind: 'convention', description: 'A', descriptionZh: 'B', status: 'published', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'paid', currency: 'SGD', priceMin: '40' };
  const saved = rules.validateEvent({ ...form, registrationEnabled: true, registrationFields: [{ id: 'badgeName' }] });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.fields.registration_enabled, true);
  assert.equal(saved.fields.registration_fields.length, 1);
  assert.equal('registration_fields' in rules.validateEvent(form).fields, false);
  const broken = [{ id: 'badgeName' }, { id: 'qx00001', type: 'text', label: '' }];
  const bad = rules.validateEvent({ ...form, registrationFields: broken });
  assert.equal(bad.field, 'registrationLabel');
  assert.equal(bad.registration, 1);
  // A free event asks no form, and its editor has no Questions tab to fix
  // one in: what it cannot take is not refused, the stored form is kept.
  const free = rules.validateEvent({ ...form, priceType: 'free', registrationFields: broken });
  assert.equal(free.ok, true, JSON.stringify(free));
  assert.equal('registration_fields' in free.fields, false);
});

test('a question can be for some tiers only', () => {
  const read = reg.readRegistrationFields([
    { id: 'tshirt', tiers: ['t-sponsor1', 't-sponsor1'] },
    { id: 'badgeName', tiers: [] },
    { id: 'qroom01', type: 'text', label: 'Room', tiers: ['t-super01'] },
  ]);
  assert.equal(read.ok, true);
  assert.deepEqual(read.fields.map((field) => [field.id, field.tiers]), [['badgeName', null], ['tshirt', ['t-sponsor1']], ['qroom01', ['t-super01']]]);
  assert.equal(reg.readRegistrationFields([{ id: 'tshirt', tiers: ['Sponsor'] }]).field, 'registrationTiers');
  assert.equal(reg.readRegistrationFields([{ id: 'tshirt', tiers: 't-sponsor1' }]).field, 'registrationTiers');
  assert.deepEqual(reg.questionsAskedOf(read.fields, ['t-attend1']).map((field) => field.id), ['badgeName']);
  assert.deepEqual(reg.questionsAskedOf(read.fields, ['t-sponsor1']).map((field) => field.id), ['badgeName', 'tshirt']);
});

test('only a paid event asks its form', async () => {
  addEvent({ price_type: 'free', currency: null });
  const fox = await signedIn('fox');
  const page = (await fox.call(detail, { query: { slug: 'mega-con' } })).json.event;
  assert.deepEqual(page.registration.fields, []);
  const joined = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.deepEqual(db.table('gftvevents_attendees')[0].registration ?? {}, {}, 'nothing asked, nothing kept');
});

test('answers are checked for their kind, and required ones are needed', () => {
  const fields = reg.readRegistrationFields([...FORM, { id: 'nfcUrl' }]).fields;
  assert.deepEqual(reg.readRegistrationAnswers(fields, { ...ANSWERS, nfcUrl: 'https://links.gftv.asia/augy', donation: '12.5' }), {
    ok: true,
    answers: { badgeName: 'Augy', nfcUrl: 'https://links.gftv.asia/augy', fursuiting: 'no', tshirt: 'S', donation: 12.5, conduct: true },
  });
  assert.deepEqual(reg.readRegistrationAnswers(fields, { ...ANSWERS, nfcUrl: 'http://x.example' }), { ok: false, error: 'registration_invalid', field: 'nfcUrl' });
  assert.deepEqual(reg.readRegistrationAnswers(fields, { ...ANSWERS, tshirt: 'XXL' }), { ok: false, error: 'registration_invalid', field: 'tshirt' });
  assert.deepEqual(reg.readRegistrationAnswers(fields, { ...ANSWERS, conduct: false }), { ok: false, error: 'registration_required', field: 'conduct' });
  assert.deepEqual(reg.readRegistrationAnswers(fields, { ...ANSWERS, badgeName: 'x'.repeat(41) }), { ok: false, error: 'registration_invalid', field: 'badgeName' });
  // A change sends only what it changes.
  assert.equal(reg.readRegistrationAnswers(fields, { tshirt: 'L' }, ANSWERS).answers.tshirt, 'L');
  assert.equal(reg.ageOn('2008-12-01', '2026-11-30'), 17);
  assert.equal(reg.ageOn('2008-12-01', '2026-12-01'), 18);
});

// ---------------------------------------------------------------------------
// Registering
// ---------------------------------------------------------------------------

test('joining needs the answers and the account details the form requires; editors see them', async () => {
  const event = addEvent({ registration_fields: reg.readRegistrationFields([...FORM, { id: 'legalName' }, { id: 'dateOfBirth' }]).fields });
  const fox = await signedIn('fox');
  const editor = await signedIn('editor', { is_editor: true });

  const page = (await fox.call(detail, { query: { slug: 'mega-con' } })).json.event;
  assert.deepEqual(page.registration.fields.map((field) => field.id), ['legalName', 'dateOfBirth', 'badgeName', 'fursuiting', 'badgePhoto', 'tshirt', 'donation', 'conduct']);
  assert.equal(page.registration.fields.every((field) => field.tiers === null), true, 'no tiers: every question for everyone');
  assert.deepEqual(page.viewer.registration.accountMissing, ['legalName', 'dateOfBirth']);
  assert.equal(page.fursuitersAsked, false, 'the form asks it, not the plain tick box');

  const short = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, registration: ANSWERS } });
  assert.equal(short.json.error, 'account_details_required');
  assert.deepEqual(short.json.fields, ['legalName', 'dateOfBirth']);

  assert.equal((await fox.call(profile, { method: 'POST', body: { legalName: 'Augustine Teo', dateOfBirth: '2010-08-05' } })).status, 200);
  const missing = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, registration: { badgeName: 'Augy' } } });
  assert.equal(missing.json.error, 'registration_required');
  assert.equal(missing.json.field, 'fursuiting');

  const joined = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, registration: { ...ANSWERS, fursuiting: 'yes' } } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.deepEqual(joined.json.event.viewer.registration.answers, { badgeName: 'Augy', fursuiting: 'yes', tshirt: 'S', conduct: true });
  assert.deepEqual(joined.json.event.viewer.registration.personal, { legalName: 'Augustine Teo', dateOfBirth: '2010-08-05' });
  assert.equal(joined.json.event.viewer.registration.open, true);
  assert.equal(db.table('gftvevents_attendees')[0].fursuiter, true, '"Are you fursuiting?" sets the fursuiter flag');

  const attendee = (await editor.call(manage, { query: { id: event.id } })).json.attendees[0];
  assert.equal(attendee.fursuiter, true);
  assert.deepEqual(attendee.registration.map((entry) => [entry.id, entry.value]), [['badgeName', 'Augy'], ['fursuiting', 'yes'], ['tshirt', 'S'], ['conduct', true]]);
  // The age at the con, not the date of birth, which the form did not ask for.
  assert.equal(attendee.personal.legalName, 'Augustine Teo');
  assert.equal(typeof attendee.personal.age, 'number');
  assert.equal(attendee.personal.under18, true);
  assert.equal('dateOfBirth' in attendee.personal, false);
});

test('a signed-out visitor sees the form\'s questions and nothing of anyone\'s answers', async () => {
  addEvent({ registration_fields: reg.readRegistrationFields([...FORM, { id: 'legalName' }]).fields });
  const page = await browser().call(detail, { query: { slug: 'mega-con' } });
  assert.equal(page.status, 200, JSON.stringify(page.json));
  assert.deepEqual(page.json.event.viewer.registration, { answers: {}, photos: {}, missing: false, accountMissing: ['legalName'], personal: {}, tier: null, asked: null, open: true });
});

test('a photo is uploaded first, sent as the answer, and shown only to its owner and editors', async () => {
  const event = addEvent();
  const fox = await signedIn('fox');
  const badger = await signedIn('badger');
  const editor = await signedIn('editor', { is_editor: true });

  const uploaded = await fox.call(photo, { method: 'POST', body: { slug: 'mega-con', question: 'badgePhoto', picture: (await webp(600, 600)).toString('base64') } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json));
  assert.match(uploaded.json.photo, reg.PHOTO_NAME);
  // Someone else's photo name is not theirs to send.
  const stolen = await badger.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, registration: { ...ANSWERS, badgePhoto: uploaded.json.photo } } });
  assert.equal(stolen.json.error, 'registration_invalid');

  const joined = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, registration: { ...ANSWERS, badgePhoto: uploaded.json.photo } } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const url = new URL(joined.json.event.viewer.registration.photos.badgePhoto, 'https://events.example');
  const query = Object.fromEntries(url.searchParams);
  const mine = await fox.call(photo, { query });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers['cache-control'], 'private, no-store');
  assert.equal((await badger.call(photo, { query })).status, 404);
  assert.equal((await badger.call(photo, { query: { ...query, u: 'fox', staff: '1' } })).status, 404, 'not an editor');

  const attendee = (await editor.call(manage, { query: { id: event.id } })).json.attendees[0];
  const entry = attendee.registration.find((each) => each.id === 'badgePhoto');
  const editorUrl = new URL(entry.photoUrl, 'https://events.example');
  assert.equal((await editor.call(photo, { query: Object.fromEntries(editorUrl.searchParams) })).status, 200);

  // A new photo while going replaces the old one at once; leaving deletes it.
  const again = await fox.call(photo, { method: 'POST', body: { slug: 'mega-con', question: 'badgePhoto', picture: (await webp(500, 500)).toString('base64') } });
  assert.equal(again.json.event.viewer.registration.answers.badgePhoto, again.json.photo);
  const files = () => [...db.objects.keys()].filter((key) => key.includes('/reg/') || key.startsWith('gftvevents_payments/reg/'));
  assert.equal(files().length, 1);
  await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: false } });
  assert.equal(files().length, 0);
});

test('answers can be changed until RSVPs close, or the tier held closes', async () => {
  const event = addPaidEvent();
  const fox = await signedIn('fox');
  const joined = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: { method: 'link', items: [{ tier: 0, tierName: 'Attendee' }] }, registration: ANSWERS } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));

  const changed = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', registration: { tshirt: 'L' } } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.event.viewer.registration.answers.tshirt, 'L');
  assert.equal(changed.json.event.viewer.registration.answers.badgeName, 'Augy');

  // The Attendee tier closes: no more changes for its holders, and it is
  // not sold any more.
  const row = db.table('gftvevents_events').find((each) => each.id === event.id);
  row.ticket_tiers = [{ ...row.ticket_tiers[0], closes_at: new Date(Date.now() - 1000).toISOString() }, row.ticket_tiers[1]];
  const closed = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', registration: { tshirt: 'M' } } });
  assert.equal(closed.status, 409);
  assert.equal(closed.json.error, 'registration_closed');
  assert.equal((await fox.call(detail, { query: { slug: 'mega-con' } })).json.event.viewer.registration.open, false);
  const badger = await signedIn('badger');
  const late = await badger.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: { method: 'link', items: [{ tier: 0, tierName: 'Attendee' }] }, registration: ANSWERS } });
  assert.equal(late.json.error, 'tier_closed');

  // RSVPs closing closes it for everyone.
  row.ticket_tiers = [{ ...row.ticket_tiers[0], closes_at: null }, row.ticket_tiers[1]];
  row.rsvp_open = false;
  assert.equal((await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', registration: { tshirt: 'M' } } })).json.error, 'registration_closed');
});

test('a donation is added to the ticket, and fixed once the order holds it', async () => {
  addPaidEvent();
  const fox = await signedIn('fox');
  const joined = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: { method: 'link', items: [{ tier: 1, tierName: 'Sponsor' }] }, registration: { ...ANSWERS, donation: '25' } } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const view = (await fox.call(checkout, { query: { slug: 'mega-con' } })).json.checkout;
  assert.equal(view.viewer.payment.amount, 200);
  assert.equal(view.viewer.donation, 25);
  await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', registration: { donation: '500' } } });
  assert.equal(db.table('gftvevents_attendees')[0].registration.donation, 25);
});

test('upgrading to a dearer tier keeps what was paid, and only the difference is owed', async () => {
  const event = addPaidEvent();
  const fox = await signedIn('fox');
  const editor = await signedIn('editor', { is_editor: true });
  await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: { method: 'link', items: [{ tier: 0, tierName: 'Attendee' }] }, registration: ANSWERS } });
  assert.equal((await fox.call(detail, { query: { slug: 'mega-con' } })).json.event.viewer.canUpgrade, true);

  // Paid and confirmed, then upgraded.
  await fox.call(payment, { method: 'POST', body: { slug: 'mega-con', action: 'report', reference: 'PAY-1' } });
  const pending = await fox.call(payment, { method: 'POST', body: { slug: 'mega-con', action: 'upgrade', tier: 1, tierName: 'Sponsor', method: 'link' } });
  assert.equal(pending.json.error, 'payment_pending_check', 'not while a reported payment waits for a check');
  await editor.call(manage, { method: 'POST', body: { action: 'payment-confirm', id: event.id, username: 'fox', staff: true, paid: true } });

  const offer = (await fox.call(checkout, { query: { slug: 'mega-con' } })).json.checkout.viewer.upgrade;
  assert.deepEqual(offer, { from: { name: 'Attendee' }, options: [{ index: 1, name: 'Sponsor', price: 175, total: 175, due: 115 }] });
  const upgraded = await fox.call(payment, { method: 'POST', body: { slug: 'mega-con', action: 'upgrade', tier: 1, tierName: 'Sponsor', method: 'link' } });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
  const mine = upgraded.json.checkout.viewer.payment;
  assert.equal(mine.tier, 'Sponsor');
  assert.equal(mine.status, 'awaiting');
  assert.equal(mine.amount, 175);
  assert.equal(mine.credit, 60);
  assert.equal(mine.due, 115);
  assert.equal(upgraded.json.checkout.viewer.upgrade, null, 'nothing dearer left');

  // The editor confirms the difference: all paid.
  await editor.call(manage, { method: 'POST', body: { action: 'payment-confirm', id: event.id, username: 'fox', staff: true, paid: true } });
  const after = (await fox.call(checkout, { query: { slug: 'mega-con' } })).json.checkout.viewer.payment;
  assert.equal(after.status, 'paid');
  assert.equal(after.due, 0);
  // Down is not an upgrade.
  assert.equal((await fox.call(payment, { method: 'POST', body: { slug: 'mega-con', action: 'upgrade', tier: 0, tierName: 'Attendee', method: 'link' } })).json.error, 'upgrade_unavailable');
});

test('a question for some tiers is asked only of the people holding them, or a tier including one', async () => {
  // A T-shirt for Sponsors, and for Super Sponsors, whose tier includes the
  // Sponsor's; a room only for Super Sponsors.
  const event = addPaidEvent({
    ticket_tiers: [
      { id: 't-attend1', name: 'Attendee', price: 60, benefits: ['Entry'], previous_display: 'reference' },
      { id: 't-sponsor1', name: 'Sponsor', price: 175, benefits: ['A shirt'], previous_display: 'reference' },
      { id: 't-super01', name: 'Super Sponsor', price: 400, benefits: ['A room'], includes: 't-sponsor1', previous_display: 'reference' },
    ],
    price_max: 400,
    registration_fields: reg.readRegistrationFields([
      { id: 'badgeName' },
      { id: 'tshirt', options: ['S', 'M', 'L'], tiers: ['t-sponsor1'] },
      { id: 'qroom01', type: 'text', label: 'Room-mate', required: true, tiers: ['t-super01', 't-gone001'] },
      { id: 'qold001', type: 'text', label: 'Old question', required: true, tiers: ['t-gone001'] },
      { id: 'conduct' },
    ]).fields,
  });
  const fox = await signedIn('fox');
  const badger = await signedIn('badger');
  const editor = await signedIn('editor', { is_editor: true });

  // The page says which tiers (by their places) each question is for; one
  // whose only tier was removed is asked of no one.
  const page = (await fox.call(detail, { query: { slug: 'mega-con' } })).json.event;
  assert.deepEqual(page.registration.fields.map((field) => [field.id, field.tiers]), [['badgeName', null], ['tshirt', [1, 2]], ['qroom01', [2]], ['qold001', []], ['conduct', null]]);

  // An Attendee is not asked for a T-shirt size.
  const basic = { badgeName: 'Augy', conduct: true };
  const attendee = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: { method: 'link', items: [{ tier: 0, tierName: 'Attendee' }] }, registration: basic } });
  assert.equal(attendee.status, 200, JSON.stringify(attendee.json));
  assert.deepEqual(attendee.json.event.viewer.registration.asked, ['badgeName', 'conduct']);
  assert.equal(attendee.json.event.viewer.registration.missing, false);

  // A Super Sponsor is asked both, the T-shirt through the Sponsor tier.
  const superBasket = { method: 'link', items: [{ tier: 2, tierName: 'Super Sponsor' }] };
  const short = await badger.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: superBasket, registration: basic } });
  assert.equal(short.json.error, 'registration_required');
  assert.equal(short.json.field, 'tshirt');
  const full = await badger.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, payment: superBasket, registration: { ...basic, tshirt: 'L', qroom01: 'Fox' } } });
  assert.equal(full.status, 200, JSON.stringify(full.json));
  assert.deepEqual(full.json.event.viewer.registration.asked, ['badgeName', 'tshirt', 'qroom01', 'conduct']);

  // The attendee list shows each the questions their tier is asked.
  const list = (await editor.call(manage, { query: { id: event.id } })).json.attendees;
  const answered = (username) => list.find((each) => each.username === username).registration.map((entry) => entry.id);
  assert.deepEqual(answered('fox'), ['badgeName', 'conduct']);
  assert.deepEqual(answered('badger'), ['badgeName', 'tshirt', 'qroom01', 'conduct']);

  // Upgraded to Sponsor: now asked for a T-shirt size, and told so.
  const upgraded = await fox.call(payment, { method: 'POST', body: { slug: 'mega-con', action: 'upgrade', tier: 1, tierName: 'Sponsor', method: 'link' } });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
  const after = (await fox.call(detail, { query: { slug: 'mega-con' } })).json.event.viewer.registration;
  assert.deepEqual(after.asked, ['badgeName', 'tshirt', 'conduct']);
  assert.equal(after.missing, true);
  const sized = await fox.call(rsvp, { method: 'POST', body: { slug: 'mega-con', registration: { tshirt: 'M' } } });
  assert.equal(sized.status, 200, JSON.stringify(sized.json));
  assert.equal(sized.json.event.viewer.registration.missing, false);
  assert.equal(sized.json.event.viewer.registration.answers.tshirt, 'M');
});

// ---------------------------------------------------------------------------
// Personal details on the account
// ---------------------------------------------------------------------------

test('the legal name and date of birth are set once; an admin corrects them', async () => {
  const fox = await signedIn('fox');
  const set = await fox.call(profile, { method: 'POST', body: { legalName: '  Augustine   Teo ', dateOfBirth: '2000-08-05', emergencyName: 'Teo Keong Meng', emergencyPhone: '9660 1257' } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.deepEqual(set.json.user.personal, { legalName: 'Augustine Teo', dateOfBirth: '2000-08-05', emergencyName: 'Teo Keong Meng', emergencyPhone: '9660 1257' });
  assert.equal((await fox.call(profile, { method: 'POST', body: { legalName: 'Someone Else' } })).json.error, 'personal_locked');
  assert.equal((await fox.call(profile, { method: 'POST', body: { dateOfBirth: '1999-01-01' } })).json.error, 'personal_locked');
  assert.equal((await fox.call(profile, { method: 'POST', body: { dateOfBirth: '2999-01-01' } })).json.error, 'date_of_birth_invalid');
  // The emergency contact can change any time.
  assert.equal((await fox.call(profile, { method: 'POST', body: { emergencyPhone: '+65 8123 4567' } })).json.user.personal.emergencyPhone, '+65 8123 4567');
  assert.equal((await fox.call(profile, { method: 'POST', body: { emergencyPhone: '12' } })).json.error, 'emergency_phone_invalid');

  const editor = await signedIn('editor', { is_editor: true });
  assert.equal((await editor.call(admin, { method: 'POST', body: { action: 'personal-fix', username: 'fox', legalName: 'Augustine Teo Jr' } })).json.error, 'admin_only');
  const boss = await signedIn('boss', { is_admin: true });
  const fixed = await boss.call(admin, { method: 'POST', body: { action: 'personal-fix', username: 'fox', legalName: '', dateOfBirth: '2000-08-06' } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.deepEqual(fixed.json.fixed, ['legal_name', 'date_of_birth']);
  // Cleared, so they can fill it in again.
  assert.equal((await fox.call(profile, { method: 'POST', body: { legalName: 'Augustine Teo' } })).json.user.personal.legalName, 'Augustine Teo');
  assert.equal(db.table('gftvevents_audit_logs').some((row) => row.action === 'admin.personal_fixed'), true);
});
