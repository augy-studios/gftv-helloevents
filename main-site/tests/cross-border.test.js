// Cross-border events and link labels (migrations/015), end to end against
// the in-memory database: what the edit form may save, the country of
// origin on an account, the RSVP it unlocks, who gets a cross-border
// event's link, and where editors see each attendee's country.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { totpAt } = await import('../api/_lib/totp.js');
const rules = await import('../api/_lib/event-rules.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const sessionRoute = await route('auth/session');
const detail = await route('events/detail');
const rsvp = await route('events/rsvp');
const manage = await route('manage/events');
const profile = await route('me/profile');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
});

async function staff(username) {
  await db.from('gftvhello_users').insert({
    username,
    display_name: username,
    email: `${username}@gftv.example`,
    password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true,
    is_editor: true,
    totp_secret: SHARED_SECRET,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  return b;
}

async function member(username = 'otter', country = 'MY') {
  const b = browser();
  const r = await b.call(signup, {
    method: 'POST',
    body: { username, displayName: username, email: `${username}@example.com`, password: PASSWORD, country, agree: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

// An account from before migrations/015: signed up, then its country taken
// away as if it never had one.
async function memberWithoutCountry(username = 'badger') {
  const b = await member(username);
  db.table('gftvevents_accounts').find((row) => row.username === username).country = null;
  return b;
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'johor-meet',
    title: 'Johor Meet',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ends_at: null,
    description: 'About.',
    description_zh: '关于。',
    external_url: 'https://t.me/johormeet',
    external_url_label: 'group',
    cross_border: true,
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

const form = (over = {}) => ({
  title: 'Johor Meet', description: 'About.', descriptionZh: '关于。', kind: 'furmeet', status: 'published',
  timezone: 'Asia/Kuala_Lumpur', startDate: '2030-12-11', priceType: 'free', ...over,
});

// ---------------------------------------------------------------------------
// The edit form
// ---------------------------------------------------------------------------

test('the link button says what the editor picked, or their own words', () => {
  const saved = (over) => rules.validateEvent(form({ externalUrl: 'https://t.me/johormeet', ...over }));
  assert.equal(saved({ externalUrlLabel: 'group' }).fields.external_url_label, 'group');
  assert.equal(saved({ externalUrlLabel: 'nonsense' }).fields.external_url_label, 'tickets_website');
  const custom = saved({ externalUrlLabel: 'custom', externalUrlCustomLabel: '  Join our Discord ' });
  assert.equal(custom.fields.external_url_label, 'custom');
  assert.equal(custom.fields.external_url_custom_label, 'Join our Discord');
  assert.equal(saved({ externalUrlLabel: 'custom', externalUrlCustomLabel: '' }).fields.external_url_label, 'custom', 'saved before the words are typed');
  assert.equal(saved({ externalUrlLabel: 'custom', externalUrlCustomLabel: 'x'.repeat(41) }).field, 'externalUrlCustomLabel');
  const kept = saved({ externalUrlLabel: 'tickets', externalUrlCustomLabel: 'Join our Discord' });
  assert.equal(kept.fields.external_url_custom_label, 'Join our Discord', 'kept while another label is picked');
  assert.equal('external_url_label' in rules.validateEvent(form()).fields, false, 'a page from before keeps what is stored');
});

test('cross-border is saved as ticked, and kept when a form sends nothing about it', () => {
  assert.equal(rules.validateEvent(form({ crossBorder: true })).fields.cross_border, true);
  assert.equal(rules.validateEvent(form({ kind: 'convention', crossBorder: false })).fields.cross_border, false, 'a convention can be unticked');
  assert.equal('cross_border' in rules.validateEvent(form()).fields, false);
});

// ---------------------------------------------------------------------------
// The country of origin
// ---------------------------------------------------------------------------

test('a country of origin is picked at sign-up and changed on the account page, by anyone', async () => {
  const refused = await browser().call(signup, {
    method: 'POST',
    body: { username: 'nocountry', displayName: 'No Country', email: 'n@example.com', password: PASSWORD, agree: true },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'country_required');

  const otter = await member('otter', 'sg');
  assert.equal((await otter.call(sessionRoute)).json.user.country, 'SG');
  const moved = await otter.call(profile, { method: 'POST', body: { country: 'id' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.user.country, 'ID');
  assert.equal((await otter.call(profile, { method: 'POST', body: { country: 'XX' } })).json.error, 'country_required');
  assert.equal((await otter.call(profile, { method: 'POST', body: { country: '' } })).json.error, 'country_required', 'never emptied');
  assert.equal((await otter.call(profile, { method: 'POST', body: {} })).status, 400);

  // Staff set a country too, though their names come from gftv.asia.
  const editor = await staff('editor');
  assert.equal((await editor.call(profile, { method: 'POST', body: { country: 'MY' } })).json.user.country, 'MY');
  assert.equal((await editor.call(profile, { method: 'POST', body: { displayName: 'New Name' } })).json.error, 'staff_account');
});

// ---------------------------------------------------------------------------
// RSVPs and the link
// ---------------------------------------------------------------------------

test('a cross-border event takes an RSVP only from someone with a country of origin', async () => {
  addEvent();
  const badger = await memberWithoutCountry();
  const page = await badger.call(detail, { query: { slug: 'johor-meet' } });
  assert.equal(page.json.event.crossBorder, true);
  assert.equal(page.json.event.viewer.needsCountry, true);
  const refused = await badger.call(rsvp, { method: 'POST', body: { slug: 'johor-meet', going: true } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'country_required');

  await badger.call(profile, { method: 'POST', body: { country: 'SG' } });
  const going = await badger.call(rsvp, { method: 'POST', body: { slug: 'johor-meet', going: true } });
  assert.equal(going.status, 200, JSON.stringify(going.json));
  assert.equal(going.json.event.viewer.going, true);
  assert.equal(going.json.event.viewer.needsCountry, false);

  // Someone already going (from before it was cross-border) can still
  // cancel, and an event that is not cross-border needs no country.
  db.table('gftvevents_accounts').find((row) => row.username === 'badger').country = null;
  assert.equal((await badger.call(rsvp, { method: 'POST', body: { slug: 'johor-meet', going: false } })).status, 200);
  addEvent({ id: crypto.randomUUID(), slug: 'local-meet', cross_border: false });
  assert.equal((await badger.call(rsvp, { method: 'POST', body: { slug: 'local-meet', going: true } })).status, 200);
});

test('a cross-border event link goes only to people signed in with a country, and to editors', async () => {
  addEvent();
  const link = async (b) => (await b.call(detail, { query: { slug: 'johor-meet' } })).json.event.externalLink;

  assert.deepEqual(await link(browser()), { url: null, label: 'group', customLabel: null, locked: 'sign-in' });
  assert.deepEqual(await link(await memberWithoutCountry()), { url: null, label: 'group', customLabel: null, locked: 'country' });
  assert.deepEqual(await link(await member('otter', 'MY')), { url: 'https://t.me/johormeet', label: 'group', customLabel: null, locked: null });
  assert.equal((await link(await staff('editor'))).url, 'https://t.me/johormeet', 'an editor, with no country');

  addEvent({ id: crypto.randomUUID(), slug: 'local-meet', cross_border: false, external_url_label: 'custom', external_url_custom_label: 'Join our Discord' });
  const local = (await browser().call(detail, { query: { slug: 'local-meet' } })).json.event.externalLink;
  assert.deepEqual(local, { url: 'https://t.me/johormeet', label: 'custom', customLabel: 'Join our Discord', locked: null }, 'open to all');
});

test('editors see where each attendee of a cross-border event is from', async () => {
  const event = addEvent();
  const otter = await member('otter', 'MY');
  await otter.call(rsvp, { method: 'POST', body: { slug: 'johor-meet', going: true } });
  const editor = await staff('editor');
  const list = (await editor.call(manage, { query: { id: event.id } })).json;
  assert.equal(list.event.crossBorder, true);
  assert.deepEqual(list.attendees.map((attendee) => [attendee.username, attendee.country]), [['otter', 'MY']]);

  // Not cross-border: nobody's country goes out.
  db.table('gftvevents_events').find((row) => row.id === event.id).cross_border = false;
  const plain = (await editor.call(manage, { query: { id: event.id } })).json;
  assert.deepEqual(plain.attendees.map((attendee) => attendee.country), [null]);
});
