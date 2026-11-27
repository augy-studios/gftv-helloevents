// Telegram alerts for the admins' and an event's organisers' chats
// (migrations/026, api/_lib/staff-alerts.js), end to end against the
// in-memory database, with a recorder in place of Telegram.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_BOT_USERNAME = 'HelloEventsTestBot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.ADMIN_CHAT_IDS = '-100111, 222 nonsense -100111';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { useTestPushSender } = await import('../api/_lib/push.js');
const { settle, changeNotice } = await import('../api/_lib/notify.js');
changeNotice.waitMs = 0;
changeNotice.graceMs = 0;
const alerts = await import('../api/_lib/staff-alerts.js');
const { utcToWall } = await import('../api/_lib/event-rules.js');
const { totpAt } = await import('../api/_lib/totp.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const rsvp = await route('events/rsvp');
const manage = await route('manage/events');
const editors = await route('manage/event-editors');
const webhook = await route('telegram/webhook');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const HOOK = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' };
let db;
let sent;

globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
  useTestPushSender(async () => {});
  sent = [];
});

// What the bot sent each chat, as { chat, markdown }.
const alertsSent = () => sent.filter((s) => s.url.endsWith('/sendRichMessage')).map((s) => ({ chat: String(s.body.chat_id), markdown: s.body.rich_message.markdown }));
const chatsTold = (heading) => alertsSent().filter((each) => each.markdown.startsWith(`## ${heading}\n`)).map((each) => each.chat).sort();

async function member(username = 'otter') {
  const b = browser();
  const r = await b.call(signup, { method: 'POST', body: { username, displayName: 'Otter Pup', email: `${username}@example.com`, password: PASSWORD, country: 'SG', agree: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return b;
}

async function staff(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@gftv.example`, password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true, totp_secret: SHARED_SECRET, ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  return b;
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'otter-meet',
    title: 'Otter Meet',
    status: 'published',
    starts_at: new Date(Math.floor((Date.now() + 7 * 86400_000) / 60_000) * 60_000).toISOString(),
    description: 'A meet.',
    description_zh: '聚会。',
    venue_name: 'Hall',
    capacity: 40,
    announced_at: new Date().toISOString(),
    admin_told_at: new Date().toISOString(),
    organiser_chat_ids: ['333', '-100444'],
    contact_fields: [{ id: 'telegram', type: 'telegram', label: 'Telegram' }],
    contact_rule: 'all',
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

const attendee = (eventId) => db.table('gftvevents_attendees').find((row) => row.event_id === eventId);

test('chat ids are a person\'s or a group\'s, once each, in order', () => {
  assert.deepEqual(alerts.parseChatIds('123, -100456\n789 123 @group abc'), ['123', '-100456', '789']);
  assert.deepEqual(alerts.parseChatIds(['1', 2, '-3']), ['1', '2', '-3']);
  assert.deepEqual(alerts.parseChatIds(null), []);
  assert.deepEqual(alerts.adminChatIds(), ['-100111', '222']);
});

test('a new attendee is told to the admins and, with their details complete, the organisers, with their contact details', async () => {
  const event = addEvent();
  const m = await member();
  const r = await m.call(rsvp, { method: 'POST', body: { slug: 'otter-meet', going: true, contact: { telegram: '@otterchat' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await settle();
  assert.deepEqual(chatsTold('New attendee'), ['-100111', '-100444', '222', '333']);
  const markdown = alertsSent()[0].markdown;
  for (const part of ['**Otter Meet**', '| Name | Otter Pup |', '| Username | otter |', '| RSVP ID | \\#1 |', '| Coming for | The whole event |', '| Going | 1 of 40 |',
    '## Contact details', '| Telegram username | @otterchat |', 'https://events.globalfurry.tv/e/otter-meet']) {
    assert.ok(markdown.includes(part), `${part} in\n${markdown}`);
  }
  assert.equal(markdown.includes('otter@example.com'), false, 'never an email');
  assert.ok(attendee(event.id).organisers_told_at);

  // Changing their details later tells nobody again.
  sent = [];
  await m.call(rsvp, { method: 'POST', body: { slug: 'otter-meet', contact: { telegram: '@otter_two' } } });
  await settle();
  assert.deepEqual(alertsSent(), []);
});

test('organisers hear about someone whose details were short only once they complete them', async () => {
  const event = addEvent({ contact_fields: [], organiser_chat_ids: [] });
  const m = await member();
  await m.call(rsvp, { method: 'POST', body: { slug: 'otter-meet', going: true } });
  await settle();
  assert.deepEqual(chatsTold('New attendee'), ['-100111', '222'], 'no organisers yet');
  assert.equal(attendee(event.id).organisers_told_at, null);

  // The organisers are added and the event now asks for a Telegram username
  // this person has not given.
  const row = db.table('gftvevents_events').find((each) => each.id === event.id);
  row.organiser_chat_ids = ['333'];
  row.contact_fields = [{ id: 'telegram', type: 'telegram', label: 'Telegram' }];
  row.contact_rule = 'all';
  sent = [];
  await alerts.alertAttendeeCompleted(row, attendee(event.id).user_id);
  assert.deepEqual(alertsSent(), [], 'still short');

  await m.call(rsvp, { method: 'POST', body: { slug: 'otter-meet', contact: { telegram: '@otterchat' } } });
  await settle();
  assert.deepEqual(chatsTold('New attendee'), ['333'], 'the organisers, not the admins again');
  assert.ok(alertsSent()[0].markdown.includes('| Telegram username | @otterchat |'));
});

test('a payment reported goes to the admins, one confirmed to the admins and the organisers', async () => {
  const event = addEvent({ price_type: 'fixed', price_min: 20, currency: 'SGD', payment_methods: ['link'], payment_link: 'https://pay.example.com/otter', contact_fields: [] });
  const m = await member();
  await m.call(rsvp, { method: 'POST', body: { slug: 'otter-meet', going: true } });
  await settle();
  const row = attendee(event.id);
  Object.assign(row, { payment_method: 'link', payment_status: 'submitted', payment_amount: 20, payment_currency: 'SGD', payment_reference: 'PAY-123', payment_items: [{ name: 'Standard', quantity: 2, price: 10 }] });

  sent = [];
  await alerts.alertPaymentReported(event, row.user_id);
  assert.deepEqual(chatsTold('Payment reported'), ['-100111', '222']);
  for (const part of ['| Ticket | Standard × 2 |', '| Payment | Payment link |', '| Status | Reported, to be checked |', '| Amount | SGD 20.00 |', '| Reference | PAY-123 |']) {
    assert.ok(alertsSent()[0].markdown.includes(part), part);
  }

  sent = [];
  const admin = await staff('boss', { is_admin: true, is_editor: true });
  const confirmed = await admin.call(manage, { method: 'POST', body: { action: 'payment-confirm', id: event.id, username: 'otter', paid: true } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  await settle();
  assert.deepEqual(chatsTold('Payment confirmed'), ['-100111', '-100444', '222', '333']);
  assert.ok(alertsSent().find((each) => each.chat === '333').markdown.includes('| Status | Paid |'));
});

test('the admins hear about a new event once it is published, once, and not about drafts', async () => {
  const event = addEvent({ status: 'draft', admin_told_at: null, organiser_chat_ids: [] });
  const ed = await staff('editor', { is_editor: true });
  const current = (await ed.call(manage, { query: { id: event.id } })).json.event;
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, summary: 'Still a draft' } } });
  await settle();
  assert.deepEqual(alertsSent(), [], 'a draft is not news');

  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, status: 'published' } } });
  await settle();
  assert.deepEqual(chatsTold('New event published'), ['-100111', '222']);
  assert.ok(alertsSent()[0].markdown.includes('**Otter Meet**'));
  assert.ok(alertsSent()[0].markdown.includes('| Kind | Furmeet |'));

  sent = [];
  await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, status: 'published', summary: 'Edited' } } });
  await settle();
  assert.deepEqual(alertsSent(), [], 'told once');
});

test('an event published to be released later is told to the admins at its release, by the cron', async () => {
  const later = new Date(Date.now() + 3600_000).toISOString();
  const event = addEvent({ status: 'draft', admin_told_at: null, organiser_chat_ids: [] });
  const ed = await staff('editor', { is_editor: true });
  const current = (await ed.call(manage, { query: { id: event.id } })).json.event;
  const saved = await ed.call(manage, { method: 'POST', body: { action: 'update', id: event.id, event: { ...current, status: 'published', publishLocal: utcToWall(later, 'Asia/Singapore') } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await settle();
  assert.deepEqual(alertsSent(), []);
  assert.equal(await alerts.flushDueAdminEvents(), 0, 'not yet');
  assert.equal(await alerts.flushDueAdminEvents(Date.now() + 2 * 3600_000), 1);
  assert.deepEqual(chatsTold('New event published'), ['-100111', '222']);
});

test('only admins set an event\'s organiser chats, each a chat id, and can test them', async () => {
  const event = addEvent({ organiser_chat_ids: [] });
  const ed = await staff('editor', { is_editor: true });
  assert.equal((await ed.call(editors, { method: 'POST', body: { id: event.id, action: 'chats', chats: '333' } })).status, 403);

  const admin = await staff('boss', { is_admin: true, is_editor: true });
  const bad = await admin.call(editors, { method: 'POST', body: { id: event.id, action: 'chats', chats: '333, @organisers' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'chat_id_invalid');
  assert.equal(bad.json.value, '@organisers');
  const many = Array.from({ length: 11 }, (unused, index) => String(1000 + index)).join(' ');
  assert.equal((await admin.call(editors, { method: 'POST', body: { id: event.id, action: 'chats', chats: many } })).json.error, 'too_many_chats');
  assert.equal((await admin.call(editors, { method: 'POST', body: { id: event.id, action: 'test-chats' } })).json.error, 'no_chats');

  const saved = await admin.call(editors, { method: 'POST', body: { id: event.id, action: 'chats', chats: '333\n-100444, 333' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.organiserChats, ['333', '-100444']);
  assert.deepEqual((await admin.call(editors, { query: { id: event.id } })).json.organiserChats, ['333', '-100444']);

  sent = [];
  const tested = await admin.call(editors, { method: 'POST', body: { id: event.id, action: 'test-chats' } });
  assert.deepEqual(tested.json.failed, []);
  assert.deepEqual(chatsTold('Organiser alerts are on'), ['-100444', '333']);
});

test('/chatid answers with the chat\'s id, in a group too', async () => {
  for (const chat of [{ id: -100555, type: 'supergroup' }, { id: 666, type: 'private' }]) {
    sent = [];
    await browser().call(webhook, { method: 'POST', headers: HOOK, body: { message: { chat, text: '/chatid@HelloEventsTestBot' } } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.chat_id, chat.id);
    assert.match(sent[0].body.text, new RegExp(`This chat's ID is ${chat.id}\\.`));
  }
  // Anything else in a group is still ignored.
  sent = [];
  await browser().call(webhook, { method: 'POST', headers: HOOK, body: { message: { chat: { id: -100555, type: 'group' }, text: '/help' } } });
  assert.equal(sent.length, 0);
});

test('a passed ID check tells the admins "username has way", however it was approved', async () => {
  const helloidChecks = await import('../api/_lib/helloid-checks.js');
  const idChecks = await import('../api/_lib/id-checks.js');
  const { idVerifiedText } = await import('../api/_lib/admin-chats.js');
  assert.equal(idVerifiedText('otter', 'helloid'), 'otter has HelloID');
  assert.equal(idVerifiedText('otter', 'didit'), 'otter has Didit');
  assert.equal(idVerifiedText('otter', 'veriff'), 'otter has Veriff');

  const plainSent = () => sent.filter((s) => s.url.endsWith('/sendMessage')).map((s) => `${s.body.chat_id}: ${s.body.text}`).sort();
  const account = (username) => db.table('gftvevents_accounts').find((row) => row.username === username);

  // HelloID, approved by its own checks.
  await member('otter');
  sent = [];
  await helloidChecks.saveHelloid(account('otter').id, { status: 'approved', decided_auto: true, verified_name: 'Otter Tan', verified_birth: '2000-01-02' });
  assert.deepEqual(plainSent(), ['-100111: otter has HelloID', '222: otter has HelloID']);

  // HelloID waiting for the admins: nothing until one approves it.
  await member('fox');
  sent = [];
  const waiting = await helloidChecks.saveHelloid(account('fox').id, { status: 'pending', verified_name: 'Fox', verified_birth: '2001-01-01' });
  assert.deepEqual(plainSent(), []);
  await helloidChecks.decideHelloid(waiting, { approved: false, reviewerId: crypto.randomUUID(), reason: 'Blurry.' });
  assert.deepEqual(plainSent(), [], 'not for a decline');
  const again = await helloidChecks.saveHelloid(account('fox').id, { status: 'pending', verified_name: 'Fox', verified_birth: '2001-01-01' });
  await helloidChecks.decideHelloid(again, { approved: true, reviewerId: crypto.randomUUID(), reason: null });
  assert.deepEqual(plainSent(), ['-100111: fox has HelloID', '222: fox has HelloID']);

  // An outside provider's approval, read once: a second read tells nobody.
  process.env.DIDIT_API_KEY = 'didit-key';
  process.env.DIDIT_WORKFLOW_ID = 'workflow-1';
  await member('wolf');
  const wolfId = account('wolf').id;
  await db.from('gftvevents_id_checks').insert({ id: crypto.randomUUID(), account_id: wolfId, provider: 'didit', provider_session_id: 'sess-w', status: 'started', created_at: new Date().toISOString() });
  const check = db.table('gftvevents_id_checks')[0];
  const telegramFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/didit\.me/.test(String(url))) {
      return new Response(JSON.stringify({ status: 'Approved', vendor_data: wolfId, id_verifications: [{ full_name: 'Wolf Lee', document_number: 'W1', issuing_state: 'SGP' }] }), { status: 200 });
    }
    return telegramFetch(url, init);
  };
  try {
    sent = [];
    await idChecks.refreshCheck(check);
    await idChecks.refreshCheck(check);
  } finally {
    globalThis.fetch = telegramFetch;
    delete process.env.DIDIT_API_KEY;
    delete process.env.DIDIT_WORKFLOW_ID;
  }
  assert.deepEqual(plainSent(), ['-100111: wolf has Didit', '222: wolf has Didit']);
});
