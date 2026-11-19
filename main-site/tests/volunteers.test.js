// Volunteers at conventions (migrations/012), end to end against the
// in-memory database: what the edit form may save, signing up to volunteer
// with an RSVP, an editor confirming who really volunteered, and the
// benefit a later convention gives them.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const rules = await import('../api/_lib/event-rules.js');
const login = (await import('../api/auth/login.js')).default;
const verify = (await import('../api/auth/verify.js')).default;
const detail = (await import('../api/events/detail.js')).default;
const rsvp = (await import('../api/events/rsvp.js')).default;
const manage = (await import('../api/manage/events.js')).default;

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
});

async function addUser(over = {}) {
  const { data } = await db
    .from('gftvhello_users')
    .insert({
      display_name: 'A Furry',
      email: `${over.username}@example.com`,
      password_hash: await bcrypt.hash(PASSWORD, 4),
      is_approved: true,
      totp_secret: SHARED_SECRET,
      ...over,
    })
    .select('id')
    .single();
  return data.id;
}

// A signed-in staff browser.
async function signedIn(username, over = {}) {
  const id = await addUser({ username, ...over });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return { b, id };
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    title: 'Furmeet',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ends_at: null,
    description: 'About.',
    description_zh: '关于。',
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

// The edit form's fields for a convention, as the browser sends them.
const conventionForm = (over = {}) => ({
  title: 'Mega Con 2026', description: 'About the con.', descriptionZh: '关于大会。', kind: 'convention', status: 'published',
  timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'paid', priceMin: '40', currency: 'SGD', ...over,
});

const attendeeNamed = (list, username) => list.find((attendee) => attendee.username === username);

// ---------------------------------------------------------------------------
// The edit form
// ---------------------------------------------------------------------------

test('only a convention takes volunteers or gives a volunteer benefit', () => {
  const source = crypto.randomUUID();
  const settings = { volunteersWanted: true, volunteerDiscountEnabled: true, volunteerDiscountFrom: source, volunteerDiscountType: 'amount', volunteerDiscountValue: '15' };
  const con = rules.validateEvent(conventionForm(settings));
  assert.equal(con.ok, true);
  assert.equal(con.fields.volunteers_wanted, true);
  assert.equal(con.fields.volunteer_discount_enabled, true);
  assert.equal(con.fields.volunteer_discount_from, source);
  assert.equal(con.fields.volunteer_discount_type, 'amount');
  assert.equal(con.fields.volunteer_discount_value, 15);

  // A furmeet has both switched off, its settings kept for switching back.
  const meet = rules.validateEvent(conventionForm({ ...settings, kind: 'furmeet' }));
  assert.equal(meet.fields.volunteers_wanted, false);
  assert.equal(meet.fields.volunteer_discount_enabled, false);
  assert.equal(meet.fields.volunteer_discount_from, source);
  // And so does one saved by a page that sends none of these fields.
  const older = rules.validateEvent(conventionForm({ kind: 'other' }));
  assert.equal(older.fields.volunteers_wanted, false);
  assert.equal('volunteer_discount_from' in older.fields, false);
  const olderCon = rules.validateEvent(conventionForm());
  assert.equal('volunteers_wanted' in olderCon.fields, false, 'a convention keeps what is stored');
});

test('the volunteer benefit is checked, and in effect only once it is complete', () => {
  const check = (over) => rules.validateEvent(conventionForm({ volunteerDiscountEnabled: true, ...over }));
  assert.deepEqual(check({ volunteerDiscountType: 'percent', volunteerDiscountValue: '101' }).field, 'volunteerDiscountValue');
  assert.deepEqual(check({ volunteerDiscountValue: '-1' }).field, 'volunteerDiscountValue');
  assert.deepEqual(check({ volunteerDiscountValue: 'lots' }).field, 'volunteerDiscountValue');
  assert.deepEqual(check({ volunteerDiscountFrom: 'not-an-id' }).field, 'volunteerDiscountFrom');
  // Ticked before the rest is filled in: saved, so autosave never refuses
  // the box, but not in effect.
  const early = check({});
  assert.equal(early.ok, true);
  assert.equal(early.fields.volunteer_discount_type, 'percent');
  assert.equal(rules.volunteerDiscountActive({ kind: 'convention', ...early.fields }), false);
  const done = check({ volunteerDiscountFrom: crypto.randomUUID(), volunteerDiscountValue: '20' });
  assert.equal(rules.volunteerDiscountActive({ kind: 'convention', ...done.fields }), true);
  assert.equal(rules.volunteerDiscountActive({ kind: 'convention', ...done.fields, volunteer_discount_enabled: false }), false);
  assert.equal(rules.volunteerDiscountActive({ kind: 'convention', ...done.fields, volunteer_discount_value: 0 }), false);
  assert.equal(rules.volunteerDiscountActive({ ...done.fields, kind: 'furmeet' }), false);
});

test('the benefit can only be for another convention, which the edit form gets back', async () => {
  const { b: editor } = await signedIn('boss', { is_editor: true });
  const lastYear = addEvent({ slug: 'mega-con-2025', title: 'Mega Con 2025', kind: 'convention' });
  const meet = addEvent({ slug: 'riverside-meet', kind: 'furmeet' });

  const notCon = await editor.call(manage, { method: 'POST', body: { action: 'create', event: conventionForm({ volunteerDiscountFrom: meet.id }) } });
  assert.equal(notCon.status, 400);
  assert.deepEqual([notCon.json.error, notCon.json.field], ['invalid_field', 'volunteerDiscountFrom']);
  const missing = await editor.call(manage, { method: 'POST', body: { action: 'create', event: conventionForm({ volunteerDiscountFrom: crypto.randomUUID() }) } });
  assert.equal(missing.json.field, 'volunteerDiscountFrom');

  const settings = { volunteersWanted: true, volunteerDiscountEnabled: true, volunteerDiscountFrom: lastYear.id, volunteerDiscountType: 'percent', volunteerDiscountValue: '20' };
  const made = await editor.call(manage, { method: 'POST', body: { action: 'create', event: conventionForm(settings) } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const event = made.json.event;
  assert.deepEqual(
    [event.volunteersWanted, event.volunteerDiscountEnabled, event.volunteerDiscountFrom, event.volunteerDiscountType, event.volunteerDiscountValue],
    [true, true, lastYear.id, 'percent', '20'],
  );

  const itself = await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, volunteerDiscountFrom: event.id } } });
  assert.equal(itself.json.field, 'volunteerDiscountFrom');

  // Made a furmeet, it stops taking volunteers.
  const asMeet = await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, kind: 'furmeet' } } });
  assert.equal(asMeet.json.event.volunteersWanted, false);
  assert.equal(asMeet.json.event.volunteerDiscountEnabled, false);
});

// ---------------------------------------------------------------------------
// Signing up to volunteer
// ---------------------------------------------------------------------------

test('someone going to a convention taking volunteers can sign up to volunteer, and change their mind', async () => {
  addEvent({ slug: 'mega-con', kind: 'convention', volunteers_wanted: true });
  addEvent({ slug: 'quiet-con', kind: 'convention' });
  addEvent({ slug: 'riverside-meet', kind: 'furmeet', volunteers_wanted: true });
  const { b } = await signedIn('helper');

  for (const slug of ['quiet-con', 'riverside-meet']) {
    const refused = await b.call(rsvp, { method: 'POST', body: { slug, going: true, volunteer: true } });
    assert.equal(refused.status, 400, slug);
    assert.equal(refused.json.error, 'volunteers_not_wanted');
  }
  assert.equal(db.table('gftvevents_attendees').length, 0, 'a refused sign-up does not RSVP either');
  const page = await b.call(detail, { query: { slug: 'riverside-meet' } });
  assert.equal(page.json.event.volunteers.wanted, false, 'a furmeet never shows as taking volunteers');

  const bad = await b.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, volunteer: 'yes' } });
  assert.equal(bad.status, 400);

  const going = await b.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, volunteer: true } });
  assert.equal(going.status, 200, JSON.stringify(going.json));
  assert.equal(going.json.event.volunteers.wanted, true);
  assert.equal(going.json.event.viewer.volunteer, true);
  assert.equal(db.table('gftvevents_attendees')[0].volunteer, true);
  assert.equal(db.table('gftvevents_audit_logs').find((row) => row.action === 'rsvp.going').details.volunteer, true);

  // A change of meals without the field leaves it as it is.
  const kept = await b.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true } });
  assert.equal(kept.json.event.viewer.volunteer, true);

  const off = await b.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, volunteer: false } });
  assert.equal(off.json.event.viewer.volunteer, false);
  assert.ok(db.table('gftvevents_audit_logs').some((row) => row.action === 'rsvp.volunteer_changed'));

  // Nobody else sees it on the public page.
  const outsider = await browser().call(detail, { query: { slug: 'mega-con' } });
  assert.equal(outsider.json.event.viewer.volunteer, false);
});

// ---------------------------------------------------------------------------
// Confirming, and the benefit at the next convention
// ---------------------------------------------------------------------------

test('an editor confirms who volunteered, and only they get the next convention\'s benefit', async () => {
  const lastYear = addEvent({ slug: 'mega-con-2025', title: 'Mega Con 2025', kind: 'convention', volunteers_wanted: true });
  const thisYear = addEvent({
    slug: 'mega-con-2026', title: 'Mega Con 2026', kind: 'convention', currency: 'SGD',
    volunteer_discount_enabled: true, volunteer_discount_from: lastYear.id, volunteer_discount_type: 'amount', volunteer_discount_value: 15,
  });
  const meet = addEvent({ slug: 'riverside-meet', kind: 'furmeet' });
  const { b: editor } = await signedIn('boss', { is_editor: true });
  const { b: helper, id: helperId } = await signedIn('helper');
  const { b: noshow } = await signedIn('noshow');
  const { b: guest } = await signedIn('guest');

  await helper.call(rsvp, { method: 'POST', body: { slug: 'mega-con-2025', going: true, volunteer: true } });
  await noshow.call(rsvp, { method: 'POST', body: { slug: 'mega-con-2025', going: true, volunteer: true } });

  const list = await editor.call(manage, { query: { id: lastYear.id } });
  assert.deepEqual(
    ['helper', 'noshow'].map((name) => attendeeNamed(list.json.attendees, name)).map((a) => [a.volunteer, a.volunteered]),
    [[true, false], [true, false]],
  );

  const confirm = (id, username, volunteered) => editor.call(manage, { method: 'POST', body: { action: 'volunteer-confirm', id, username, staff: true, volunteered } });
  const confirmed = await confirm(lastYear.id, 'helper', true);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(attendeeNamed(confirmed.json.attendees, 'helper').volunteered, true);
  assert.equal(attendeeNamed(confirmed.json.attendees, 'noshow').volunteered, false);
  assert.equal(db.table('gftvevents_volunteers').length, 1);
  assert.equal(db.table('gftvevents_volunteers')[0].user_id, helperId);
  assert.equal((await confirm(lastYear.id, 'helper', true)).status, 200, 'confirming twice is fine');
  assert.equal(db.table('gftvevents_volunteers').length, 1);
  assert.equal((await confirm(lastYear.id, 'nobody', true)).status, 404);
  assert.equal((await confirm(meet.id, 'helper', true)).json.error, 'volunteers_convention_only');

  // The public page says what the benefit is, and whose volunteers get it.
  const outsider = await browser().call(detail, { query: { slug: 'mega-con-2026' } });
  assert.deepEqual(outsider.json.event.volunteers.discount, { type: 'amount', value: 15, currency: 'SGD', fromTitle: 'Mega Con 2025', fromSlug: 'mega-con-2025' });
  assert.equal(outsider.json.event.viewer.volunteerDiscount, false);

  // The confirmed volunteer has it; one who only signed up, and anyone else, does not.
  assert.equal((await helper.call(detail, { query: { slug: 'mega-con-2026' } })).json.event.viewer.volunteerDiscount, true);
  assert.equal((await noshow.call(detail, { query: { slug: 'mega-con-2026' } })).json.event.viewer.volunteerDiscount, false);
  assert.equal((await guest.call(detail, { query: { slug: 'mega-con-2026' } })).json.event.viewer.volunteerDiscount, false);
  // On last year's page, they see their thanks.
  assert.equal((await helper.call(detail, { query: { slug: 'mega-con-2025' } })).json.event.viewer.volunteered, true);

  // Going this year, editors see who gets it.
  await helper.call(rsvp, { method: 'POST', body: { slug: 'mega-con-2026', going: true } });
  await noshow.call(rsvp, { method: 'POST', body: { slug: 'mega-con-2026', going: true } });
  const now = await editor.call(manage, { query: { id: thisYear.id } });
  assert.equal(attendeeNamed(now.json.attendees, 'helper').pastVolunteer, true);
  assert.equal(attendeeNamed(now.json.attendees, 'noshow').pastVolunteer, false);

  // Switched off, nobody has it.
  db.table('gftvevents_events').find((row) => row.id === thisYear.id).volunteer_discount_enabled = false;
  const off = await helper.call(detail, { query: { slug: 'mega-con-2026' } });
  assert.equal(off.json.event.volunteers.discount, null);
  assert.equal(off.json.event.viewer.volunteerDiscount, false);
  assert.equal(attendeeNamed((await editor.call(manage, { query: { id: thisYear.id } })).json.attendees, 'helper').pastVolunteer, false);

  // Taken back, the record goes.
  await confirm(lastYear.id, 'helper', false);
  assert.equal(db.table('gftvevents_volunteers').length, 0);
  assert.ok(db.table('gftvevents_audit_logs').some((row) => row.action === 'volunteer.unconfirmed'));
});

test('a benefit for a convention not public yet does not name it', async () => {
  const hidden = addEvent({ slug: 'secret-con', title: 'Secret Con', kind: 'convention', status: 'draft' });
  addEvent({ slug: 'open-con', kind: 'convention', volunteer_discount_enabled: true, volunteer_discount_from: hidden.id, volunteer_discount_value: 10 });
  const page = await browser().call(detail, { query: { slug: 'open-con' } });
  assert.deepEqual(page.json.event.volunteers.discount, { type: 'percent', value: 10, currency: null, fromTitle: null, fromSlug: null });
  assert.equal(JSON.stringify(page.json).includes('Secret Con'), false);
});

test('an editor removing someone takes back their confirmation; leaving after the convention does not', async () => {
  const con = addEvent({ slug: 'mega-con', kind: 'convention', volunteers_wanted: true });
  const { b: editor } = await signedIn('boss', { is_editor: true });
  const { b: helper } = await signedIn('helper');
  const { b: other } = await signedIn('other');
  await helper.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, volunteer: true } });
  await other.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true, volunteer: true } });
  for (const username of ['helper', 'other']) {
    await editor.call(manage, { method: 'POST', body: { action: 'volunteer-confirm', id: con.id, username, staff: true, volunteered: true } });
  }
  assert.equal(db.table('gftvevents_volunteers').length, 2);

  await editor.call(manage, { method: 'POST', body: { action: 'remove-attendee', id: con.id, username: 'other', staff: true } });
  assert.equal(db.table('gftvevents_volunteers').length, 1);

  // The convention is over; the helper takes back their RSVP, but they did volunteer.
  const row = db.table('gftvevents_events').find((each) => each.id === con.id);
  row.starts_at = new Date(Date.now() - 2 * 86400_000).toISOString();
  row.last_at = row.starts_at;
  await helper.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: false } });
  assert.equal(db.table('gftvevents_volunteers').length, 1);
});
