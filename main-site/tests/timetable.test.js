// Timetables (migrations/014), end to end against the in-memory database:
// what the edit form may save, what the event page gets (and when it gets
// nothing), and the notice people going get when it changes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.VAPID_PUBLIC_KEY = 'B'.repeat(87);
process.env.VAPID_PRIVATE_KEY = 'test-private-key';
process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { useTestPushSender } = await import('../api/_lib/push.js');
const { settle, changeNotice } = await import('../api/_lib/notify.js');
const notify = await import('../api/_lib/notify.js');
changeNotice.waitMs = 0;
changeNotice.graceMs = 0;
const { totpAt } = await import('../api/_lib/totp.js');
const rules = await import('../api/_lib/event-rules.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const detail = await route('events/detail');
const rsvp = await route('events/rsvp');
const manage = await route('manage/events');
const notifications = await route('me/notifications');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;
let pushes;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
  pushes = [];
  useTestPushSender(async (sub, body) => {
    pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
  });
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

async function member() {
  const b = browser();
  const r = await b.call(signup, {
    method: 'POST',
    body: { username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, country: 'SG', agree: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

// The edit form's fields, as the browser sends them.
const form = (over = {}) => ({
  title: 'Mega Con', description: 'About the con.', descriptionZh: '关于大会。', kind: 'convention', status: 'published',
  timezone: 'Asia/Singapore', startDate: '2030-12-11', endDate: '2030-12-13', priceType: 'free', ...over,
});

const ROOMS = [
  { id: 'r-ballroom', name: 'Grand Ballroom', tag: 'Level 1' },
  { id: 'r-jade0001', name: 'Panel 1 Jade', tag: 'Level G' },
];

// ---------------------------------------------------------------------------
// The edit form
// ---------------------------------------------------------------------------

test('a timetable is checked, put in time order, and kept when a form sends none of it', () => {
  const saved = rules.validateEvent(form({
    timetableView: 'grid',
    timetableRooms: [...ROOMS, { id: 'r-blank001', name: '', tag: '' }],
    timetableItems: [
      { title: 'Dance Night', date: '2030-12-11', start: '21:00', end: '01:00', room: 'r-ballroom', note: '' },
      { title: 'Inflatable Meet', date: '2030-12-11', start: '10:30', end: '15:00', room: 'r-jade0001', note: 'Bring a pump' },
      { title: 'Opening', date: '2030-12-11', start: '10:30', end: '11:00', room: 'r-ballroom', note: '' },
      { title: 'Con tags', date: '2030-12-11', start: '10:00', end: '', room: 'r-gone0001', note: '' },
      // A new card with only its day filled in: dropped.
      { title: '', date: '2030-12-11', start: '', end: '', room: 'r-ballroom', note: '' },
    ],
  }));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.fields.timetable_view, 'grid');
  assert.deepEqual(saved.fields.timetable_rooms, ROOMS, 'a blank room is dropped');
  assert.deepEqual(saved.fields.timetable_items.map((item) => item.title), ['Con tags', 'Opening', 'Inflatable Meet', 'Dance Night'],
    'by start, then by room order');
  assert.deepEqual(saved.fields.timetable_items[0], { title: 'Con tags', date: '2030-12-11', start: '10:00', end: null, room: null, note: null },
    'a room no longer there leaves the item in none');
  assert.equal(saved.fields.timetable_items[2].note, 'Bring a pump');

  const older = rules.validateEvent(form());
  assert.equal('timetable_items' in older.fields, false, 'a page from before timetables keeps what is stored');
  assert.equal(rules.validateEvent(form({ timetableView: 'list' })).fields.timetable_view, 'timeline');
});

test('a refused timetable field says which room or item', () => {
  const check = (rooms, items) => rules.validateEvent(form({ timetableView: 'timeline', timetableRooms: rooms, timetableItems: items }));
  const item = (over) => ({ title: 'Panel', date: '2030-12-11', start: '13:00', end: '14:00', room: '', note: '', ...over });
  const refused = (result) => ({ field: result.field, room: result.room, item: result.item });

  assert.deepEqual(refused(check([], [item(), item({ title: '' })])), { field: 'itemTitle', room: undefined, item: 1 });
  assert.deepEqual(refused(check([], [item({ date: '2030-02-30' })])), { field: 'itemDate', room: undefined, item: 0 });
  assert.deepEqual(refused(check([], [item({ start: '' })])), { field: 'itemStart', room: undefined, item: 0 });
  assert.deepEqual(refused(check([], [item({ end: '13:00' })])), { field: 'itemEnd', room: undefined, item: 0 }, 'an end at its start');
  assert.deepEqual(refused(check([], [item({ end: '25:00' })])), { field: 'itemEnd', room: undefined, item: 0 });
  assert.deepEqual(refused(check([], [item({ note: 'x'.repeat(301) })])), { field: 'itemNote', room: undefined, item: 0 });
  assert.deepEqual(refused(check([ROOMS[0], { id: 'r-jade0001', name: '', tag: 'Level G' }], [])), { field: 'roomName', room: 1, item: undefined });
  assert.deepEqual(refused(check([ROOMS[0], ROOMS[0]], [])), { field: 'timetableRooms', room: 1, item: undefined }, 'one id twice');
  assert.deepEqual(refused(check([{ id: 'room-1', name: 'Hall' }], [])), { field: 'timetableRooms', room: 0, item: undefined });
  assert.equal(check([], Array.from({ length: rules.MAX_TIMETABLE_ITEMS + 1 }, () => item())).field, 'timetableItems');
  assert.equal(check(Array.from({ length: rules.MAX_ROOMS + 1 }, (_, index) => ({ id: `r-room${String(index).padStart(4, '0')}`, name: 'Hall' })), []).field, 'timetableRooms');
});

test('an item ending earlier than it starts ends the next day', () => {
  const late = { title: 'Dance', date: '2030-12-31', start: '21:00', end: '01:00', room: null, note: null };
  assert.deepEqual(rules.itemTimes(late, 'Asia/Singapore'), {
    startsAt: '2030-12-31T13:00:00.000Z', endsAt: '2030-12-31T17:00:00.000Z', endsNextDay: true,
  });
  assert.deepEqual(rules.itemTimes({ ...late, end: null }, 'Asia/Singapore'), { startsAt: '2030-12-31T13:00:00.000Z', endsAt: null, endsNextDay: false });
  assert.equal(rules.nextDate('2030-12-31'), '2031-01-01');
});

// ---------------------------------------------------------------------------
// The event page
// ---------------------------------------------------------------------------

test('the event page shows the timetable, except while the dates are to be announced', async () => {
  const editor = await staff('editor');
  const made = await editor.call(manage, {
    method: 'POST',
    body: {
      action: 'create',
      event: form({
        timetableView: 'grid',
        timetableRooms: ROOMS,
        timetableItems: [
          { title: 'Dance Night', date: '2030-12-12', start: '21:00', end: '00:00', room: 'r-ballroom', note: '' },
          { title: 'Opening', date: '2030-12-11', start: '15:30', end: '16:00', room: 'r-ballroom', note: 'Doors at 15:15' },
          { title: 'Con tags', date: '2030-12-11', start: '10:00', end: '', room: '', note: '' },
        ],
      }),
    },
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const event = made.json.event;
  assert.equal(event.timetableView, 'grid');
  assert.deepEqual(event.timetableRooms, [{ id: 'r-ballroom', name: 'Grand Ballroom', tag: 'Level 1' }, { id: 'r-jade0001', name: 'Panel 1 Jade', tag: 'Level G' }]);
  assert.deepEqual(event.timetableItems.map((item) => [item.title, item.room, item.end]), [
    ['Con tags', '', ''], ['Opening', 'r-ballroom', '16:00'], ['Dance Night', 'r-ballroom', '00:00'],
  ], 'in time order, blanks as the form shows them');

  const page = await browser().call(detail, { query: { slug: 'mega-con' } });
  const timetable = page.json.event.timetable;
  assert.equal(timetable.view, 'grid');
  assert.deepEqual(timetable.rooms, [{ name: 'Grand Ballroom', tag: 'Level 1' }, { name: 'Panel 1 Jade', tag: 'Level G' }], 'no room ids');
  assert.deepEqual(timetable.items[1], {
    title: 'Opening', date: '2030-12-11', start: '15:30', end: '16:00', endsNextDay: false,
    startsAt: '2030-12-11T07:30:00.000Z', endsAt: '2030-12-11T08:00:00.000Z', room: 0, note: 'Doors at 15:15',
  });
  assert.equal(timetable.items[0].room, null);
  assert.equal(timetable.items[2].endsNextDay, true, 'midnight is the next day');

  // As an itinerary: times only, no ends or rooms.
  await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, timetableView: 'timeline' } } });
  const itinerary = (await browser().call(detail, { query: { slug: 'mega-con' } })).json.event.timetable;
  assert.equal(itinerary.view, 'timeline');
  assert.deepEqual(itinerary.rooms, []);
  assert.deepEqual(itinerary.items.map((item) => [item.start, item.end, item.endsAt, item.room]), [
    ['10:00', null, null, null], ['15:30', null, null, null], ['21:00', null, null, null],
  ]);
  const kept = (await editor.call(manage, { query: { id: event.id } })).json.event;
  assert.equal(kept.timetableRooms.length, 2, 'the rooms are kept for switching back');
  assert.equal(kept.timetableItems[1].end, '16:00');

  // The days would give the dates away.
  await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, datesHidden: true } } });
  assert.equal((await browser().call(detail, { query: { slug: 'mega-con' } })).json.event.timetable, null);
  // And no items: nothing to show.
  await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, timetableItems: [] } } });
  assert.equal((await browser().call(detail, { query: { slug: 'mega-con' } })).json.event.timetable, null);
});

test('a refused timetable item is named in the answer', async () => {
  const editor = await staff('editor');
  const refused = await editor.call(manage, {
    method: 'POST',
    body: { action: 'create', event: form({ timetableRooms: [], timetableItems: [{ title: 'Panel', date: '2030-12-11', start: '', end: '', room: '', note: '' }] }) },
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json, { ok: false, error: 'invalid_field', field: 'itemStart', item: 0 });
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

test('a change to the timetable people can see is announced; how it is shown is not', () => {
  const room = { id: 'r-ballroom', name: 'Grand Ballroom', tag: null };
  const opening = { title: 'Opening', date: '2030-12-11', start: '15:30', end: '16:00', room: 'r-ballroom', note: null };
  const live = {
    status: 'published', publish_at: null, starts_at: '2030-12-11T02:00:00.000Z', dates_hidden: false,
    timetable_view: 'grid', timetable_rooms: [room], timetable_items: [opening],
  };
  assert.equal(notify.changeKind(live, { ...live, timetable_view: 'timeline' }), null, 'the view only');
  assert.equal(notify.changeKind(live, { ...live, timetable_items: [{ ...opening, start: '16:00', end: '16:30' }] }), 'timetable');
  assert.equal(notify.changeKind(live, { ...live, timetable_items: [] }), 'timetable', 'an item taken off');
  assert.equal(notify.changeKind(live, { ...live, timetable_rooms: [{ ...room, name: 'Ballroom B' }] }), 'timetable', 'its room renamed');
  assert.equal(notify.changeKind(live, { ...live, timetable_rooms: [{ ...room, id: 'r-other001' }], timetable_items: [{ ...opening, room: 'r-other001' }] }), null,
    'the same name under a new id');
  assert.equal(notify.changeKind(live, { ...live, dates_hidden: true, timetable_items: [] }), 'updated', 'the dates taken off say so instead');
  assert.equal(notify.changeKind({ ...live, status: 'draft' }, { ...live, timetable_items: [] }), null, 'not public before');
  const { timetable_items: _dropped, ...oldBase } = live;
  assert.equal(notify.changeKind(oldBase, { ...live, timetable_items: [] }), null, 'a base from before timetables');
  assert.equal(notify.changeKind(live, { ...live, starts_at: '2030-12-12T02:00:00.000Z', timetable_items: [] }), 'updated', 'a move says so first');

  // An itinerary shows no ends or rooms, so changing those tells nobody.
  const itinerary = { ...live, timetable_view: 'timeline' };
  assert.equal(notify.changeKind(itinerary, { ...itinerary, timetable_items: [{ ...opening, end: '17:00' }] }), null, 'an end it does not show');
  assert.equal(notify.changeKind(itinerary, { ...itinerary, timetable_rooms: [{ ...room, name: 'Ballroom B' }] }), null, 'a room it does not show');
  assert.equal(notify.changeKind(itinerary, { ...itinerary, timetable_items: [{ ...opening, start: '12:00' }] }), 'timetable', 'a step at a new time');
});

test('people going hear once when the timetable changes', async () => {
  const editor = await staff('editor');
  const made = await editor.call(manage, {
    method: 'POST',
    body: { action: 'create', event: form({ timetableRooms: [], timetableItems: [{ title: 'Opening', date: '2030-12-11', start: '15:30', end: '', room: '', note: '' }] }) },
  });
  const event = made.json.event;
  const otter = await member();
  await otter.call(notifications, {
    method: 'POST',
    body: { action: 'subscribe', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/otter', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } } },
  });
  await otter.call(rsvp, { method: 'POST', body: { slug: 'mega-con', going: true } });
  await settle();
  pushes = [];

  await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, timetableView: 'grid' } } });
  await settle();
  assert.equal(pushes.length, 0, 'how it is shown is not news');

  const moved = [{ ...event.timetableItems[0], start: '16:00' }];
  await editor.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...event, timetableItems: moved } } });
  await settle();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, 'Timetable updated: Mega Con');
  assert.match(pushes[0].payload.body, /timetable changed/);
});
