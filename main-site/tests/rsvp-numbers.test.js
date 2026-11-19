// RSVP IDs (migrations/013), end to end against the in-memory database:
// each event numbers the people who RSVP from 1, a number is never reused,
// changing meals keeps it, and only the person and editors see it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const login = (await import('../api/auth/login.js')).default;
const verify = (await import('../api/auth/verify.js')).default;
const detail = (await import('../api/events/detail.js')).default;
const rsvp = (await import('../api/events/rsvp.js')).default;
const manage = (await import('../api/manage/events.js')).default;
const rsvps = (await import('../api/me/rsvps.js')).default;

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
});

// A signed-in staff browser.
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
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return b;
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    title: 'Furmeet',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ends_at: null,
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

const going = async (b, slug, body = {}) => {
  const answer = await b.call(rsvp, { method: 'POST', body: { slug, going: true, ...body } });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json.event.viewer.rsvpNumber;
};

test('each event numbers the people who RSVP from 1, furmeet or convention', async () => {
  addEvent({ slug: 'riverside-meet', kind: 'furmeet' });
  addEvent({ slug: 'mega-con', kind: 'convention', meal_options: [{ id: 'lunch', label: null }] });
  const [fox, otter, wolf] = [await signedIn('fox'), await signedIn('otter'), await signedIn('wolf')];

  assert.equal(await going(fox, 'riverside-meet'), 1);
  assert.equal(await going(otter, 'riverside-meet'), 2);
  // Another event counts on its own; just for a meal counts too.
  assert.equal(await going(otter, 'mega-con', { meals: ['lunch'] }), 1);
  assert.equal(await going(wolf, 'riverside-meet'), 3);
  assert.equal(await going(fox, 'mega-con'), 2);

  // The page says it again, and saying going again keeps it, as does a change of meals.
  assert.equal((await otter.call(detail, { query: { slug: 'riverside-meet' } })).json.event.viewer.rsvpNumber, 2);
  assert.equal(await going(otter, 'riverside-meet'), 2);
  assert.equal(await going(otter, 'mega-con', { meals: [] }), 1);
});

test('a number is never handed out twice, even after someone takes back their RSVP', async () => {
  const event = addEvent({ slug: 'riverside-meet' });
  const [fox, otter, wolf] = [await signedIn('fox'), await signedIn('otter'), await signedIn('wolf')];
  assert.equal(await going(fox, 'riverside-meet'), 1);
  assert.equal(await going(otter, 'riverside-meet'), 2);

  const left = await otter.call(rsvp, { method: 'POST', body: { slug: 'riverside-meet', going: false } });
  assert.equal(left.json.event.viewer.rsvpNumber, null);
  assert.equal(await going(wolf, 'riverside-meet'), 3, '2 is not reused');
  assert.equal(await going(otter, 'riverside-meet'), 4, 'coming back is a new RSVP');

  const numbers = db.table('gftvevents_attendees').filter((row) => row.event_id === event.id).map((row) => row.rsvp_number).sort();
  assert.deepEqual(numbers, [1, 3, 4]);
});

test('editors see everyone\'s number, the person sees their own, nobody else sees any', async () => {
  const event = addEvent({ slug: 'riverside-meet' });
  const editor = await signedIn('boss', { is_editor: true });
  const [fox, otter] = [await signedIn('fox'), await signedIn('otter')];
  await going(fox, 'riverside-meet');
  await going(otter, 'riverside-meet');

  const list = await editor.call(manage, { query: { id: event.id } });
  assert.deepEqual(list.json.attendees.map((attendee) => [attendee.username, attendee.rsvpNumber]), [['fox', 1], ['otter', 2]]);

  const mine = await otter.call(rsvps);
  assert.equal(mine.json.upcoming[0].rsvpNumber, 2);

  const outsider = await browser().call(detail, { query: { slug: 'riverside-meet' } });
  assert.equal(outsider.json.event.viewer.rsvpNumber, null);
  const editorView = await editor.call(detail, { query: { slug: 'riverside-meet' } });
  assert.equal(editorView.json.event.viewer.rsvpNumber, null, 'an editor not going has none of their own');
});
