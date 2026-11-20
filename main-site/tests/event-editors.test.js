// Editors of one event (migrations/018), end to end against the in-memory
// database: an admin adds an account active in the last 30 days; with
// two-step sign-in on, it reaches that event alone on /manage (its form, its
// attendees, its uploads), cannot create, delete, publish or move its
// release time; without two-step sign-in it reaches nothing.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.SUPABASE_URL = 'https://project.supabase.co';
const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { totpAt } = await import('../api/_lib/totp.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const signup = await route('auth/signup');
const sessionRoute = await route('auth/session');
const detail = await route('events/detail');
const manage = await route('manage/events');
const editorsRoute = await route('manage/event-editors');
const admin = await route('manage/admin');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
});

async function staff(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@gftv.example`,
    password_hash: await bcrypt.hash(PASSWORD, 4), is_approved: true, totp_secret: SHARED_SECRET, ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  return b;
}

// A public account, signed up (and so signed in, and active now).
async function member(username) {
  const b = browser();
  const r = await b.call(signup, { method: 'POST', body: { username, displayName: username, email: `${username}@example.com`, password: PASSWORD, country: 'SG', agree: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

const accountOf = (username) => db.table('gftvevents_accounts').find((each) => each.username === username);

// Two-step sign-in on, the way an authenticator app turns it on.
function turnOnTwoStep(username) {
  db.table('gftvevents_totp_secrets').push({ user_id: accountOf(username).id, secret_encrypted: 'x', created_at: new Date().toISOString() });
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(), slug: `event-${db.table('gftvevents_events').length + 1}`, title: 'An event', status: 'draft',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(), description: 'A.', description_zh: '甲。', ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

test('an admin adds an active account as an event editor, from the dropdown', async () => {
  const theirs = addEvent({ title: 'Their meet' });
  const boss = await staff('boss', { is_admin: true });
  await member('organiser');
  await member('olduser');
  // Signed in more than 30 days ago: not offered.
  accountOf('olduser').last_sign_in_at = new Date(Date.now() - 40 * 86400_000).toISOString();
  await staff('helper', { is_editor: true });

  const first = await boss.call(editorsRoute, { query: { id: theirs.id } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(first.json.editors, []);
  const offered = first.json.candidates.map((each) => each.username);
  assert.equal(offered.includes('organiser'), true);
  assert.equal(offered.includes('olduser'), false, 'not active in the last 30 days');
  assert.equal(offered.includes('helper'), false, 'staff editors edit everything anyway');

  const added = await boss.call(editorsRoute, { method: 'POST', body: { id: theirs.id, action: 'add', username: 'organiser' } });
  assert.deepEqual(added.json.editors, [{ username: 'organiser', displayName: 'organiser', staff: false, twoStep: false }]);
  assert.equal(added.json.candidates.some((each) => each.username === 'organiser'), false);
  assert.equal((await boss.call(editorsRoute, { method: 'POST', body: { id: theirs.id, action: 'add', username: 'olduser' } })).json.error, 'editor_not_found');

  // Only admins choose them.
  const helper = await staff('helper2', { is_editor: true });
  assert.equal((await helper.call(editorsRoute, { query: { id: theirs.id } })).status, 403);

  const removed = await boss.call(editorsRoute, { method: 'POST', body: { id: theirs.id, action: 'remove', username: 'organiser', staff: false } });
  assert.deepEqual(removed.json.editors, []);
});

test('an event editor with two-step sign-in reaches that event alone, and cannot publish, create or delete', async () => {
  const theirs = addEvent({ title: 'Their meet' });
  const other = addEvent({ title: 'Another meet' });
  const boss = await staff('boss', { is_admin: true });
  const organiser = await member('organiser');
  await boss.call(editorsRoute, { method: 'POST', body: { id: theirs.id, action: 'add', username: 'organiser' } });

  // Without two-step sign-in: nothing yet.
  assert.equal((await organiser.call(sessionRoute)).json.user.editsEvents, false);
  assert.equal((await organiser.call(manage)).status, 403);

  turnOnTwoStep('organiser');
  assert.equal((await organiser.call(sessionRoute)).json.user.editsEvents, true);
  assert.equal((await organiser.call(sessionRoute)).json.user.canManage, false);

  // Their event alone.
  const list = await organiser.call(manage);
  assert.deepEqual(list.json.events.map((each) => each.title), ['Their meet']);
  const form = (await organiser.call(manage, { query: { id: theirs.id } })).json.event;
  assert.equal((await organiser.call(manage, { query: { id: other.id } })).status, 404);
  // A preview of the draft, with "Edit this event".
  const page = await organiser.call(detail, { query: { slug: theirs.slug } });
  assert.equal(page.status, 200);
  assert.equal(page.json.preview, true);
  assert.equal(page.json.event.viewer.canManage, true);
  assert.equal((await organiser.call(detail, { query: { slug: other.slug } })).status, 404);

  // Edits save; the Status and release time stay as staff left them.
  const saved = await organiser.call(manage, { method: 'POST', body: { action: 'update', id: theirs.id, event: { ...form, title: 'Their great meet', status: 'published', publishLocal: '2030-01-01T10:00' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.event.title, 'Their great meet');
  assert.equal(saved.json.event.status, 'draft');
  assert.equal(saved.json.event.publishLocal, '');

  // Not another event, not a new one, not deleting, not the staff tools.
  assert.equal((await organiser.call(manage, { method: 'POST', body: { action: 'update', id: other.id, event: form } })).status, 404);
  assert.equal((await organiser.call(manage, { method: 'POST', body: { action: 'create', event: form } })).status, 403);
  assert.equal((await organiser.call(manage, { method: 'POST', body: { action: 'delete', id: theirs.id } })).status, 403);
  assert.equal((await organiser.call(admin)).status, 403);

  // Taken off: nothing again.
  await boss.call(editorsRoute, { method: 'POST', body: { id: theirs.id, action: 'remove', username: 'organiser' } });
  assert.equal((await organiser.call(manage)).status, 403);
});
