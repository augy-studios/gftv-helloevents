// ID checks, check-in and entry codes (migrations/027), end to end against
// the in-memory database, with the outside providers (Didit, Veriff)
// answered by a stand-in for fetch. HelloID's face models are not loaded
// here: its decisions are stored through helloid-checks.js as the route
// stores them, and its pure parts (the challenge, names, the device) are
// tested on their own.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.DIDIT_API_KEY = 'didit-key';
process.env.DIDIT_WORKFLOW_ID = 'workflow-1';
process.env.DIDIT_WEBHOOK_SECRET = 'didit-secret';
process.env.VERIFF_API_KEY = 'veriff-key';
process.env.VERIFF_SHARED_SECRET = 'veriff-secret';
process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const checkinLib = await import('../api/_lib/checkin.js');
const helloidChecks = await import('../api/_lib/helloid-checks.js');
const { settle } = await import('../api/_lib/notify.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const signup = await route('auth/signup');
const detail = await route('events/detail');
const rsvp = await route('events/rsvp');
const selfCheckin = await route('events/checkin');
const entryCode = await route('events/entry-code');
const checkin = await route('manage/checkin');
const manage = await route('manage/events');
const admin = await route('manage/admin');
const reviews = await route('manage/helloid');
const idcheck = await route('me/idcheck');
const idReturn = await route('idcheck/return');
const webhook = await route('idcheck/webhook');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;
let providerAnswers;
let providerCalls;

// The outside providers' APIs, answered from providerAnswers by address.
globalThis.fetch = async (url, init = {}) => {
  const address = String(url);
  providerCalls.push({ url: address, init });
  const found = providerAnswers.find(([pattern]) => pattern.test(address));
  if (!found) {
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  return new Response(JSON.stringify(found[1]), { status: 200 });
};

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  providerAnswers = [];
  providerCalls = [];
});

async function staff(username, over = {}) {
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

let ipCount = 10;
async function member(username = 'otter') {
  const b = browser();
  const joined = await b.call(signup, {
    method: 'POST',
    ip: `198.51.100.${ipCount++}`,
    body: { username, displayName: username, email: `${username}@example.com`, password: PASSWORD, country: 'SG', agree: true },
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  return b;
}

function account(username) {
  return db.table('gftvevents_accounts').find((row) => row.username === username);
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(), slug: 'door-meet', title: 'Door Meet', status: 'published', kind: 'furmeet',
    starts_at: new Date(Date.now() + 2 * 86400_000).toISOString(), price_type: 'free',
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

const join = (b, slug = 'door-meet') => b.call(rsvp, { method: 'POST', body: { slug, going: true } });

// ---------------------------------------------------------------------------
// Requiring an ID check
// ---------------------------------------------------------------------------

test('an event requiring an ID check takes an RSVP only once one it accepts has passed, or HelloID waits', async () => {
  addEvent({ id_check_providers: ['didit', 'helloid'] });
  const otter = await member();
  const page = (await otter.call(detail, { query: { slug: 'door-meet' } })).json.event;
  assert.deepEqual(page.idCheckProviders, ['didit', 'helloid']);
  assert.equal(page.viewer.needsIdCheck, true);
  assert.equal((await join(otter)).json.error, 'id_check_required');

  // Veriff is not one it accepts.
  account('otter').id_verified_providers = ['veriff'];
  assert.equal((await join(otter)).json.error, 'id_check_required');
  // A HelloID check waiting for the admins will do meanwhile.
  account('otter').helloid_pending = true;
  assert.equal((await join(otter)).status, 200);

  const fox = await member('fox');
  account('fox').id_verified_providers = ['didit'];
  const going = await join(fox);
  assert.equal(going.status, 200);
  assert.equal(going.json.event.viewer.needsIdCheck, false);

  // An event that asks for none takes anyone, as before.
  addEvent({ slug: 'open-meet' });
  const cat = await member('cat');
  assert.equal((await join(cat, 'open-meet')).status, 200);
});

test('the edit form saves the ID checks, the door check and the entry code settings', () => {
  return import('../api/_lib/event-rules.js').then((rules) => {
    const form = { title: 'Meet', kind: 'furmeet', description: 'A', descriptionZh: 'B', status: 'published', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'free' };
    const saved = rules.validateEvent({ ...form, idCheckProviders: ['veriff', 'nfc-magic', 'helloid'], idCheckDoor: true, entryQrMode: 'each', entryQrAudience: 'paid', entryQrShow: 'before', entryQrHours: '3' });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.fields.id_check_providers, ['veriff', 'helloid'], 'unknown ways are dropped');
    assert.deepEqual([saved.fields.id_check_door, saved.fields.entry_qr_mode, saved.fields.entry_qr_audience, saved.fields.entry_qr_show, saved.fields.entry_qr_hours], [true, 'each', 'paid', 'before', 3]);
    assert.equal(rules.validateEvent({ ...form, entryQrMode: 'all' }).field, 'entryQrMode');
    assert.equal(rules.validateEvent({ ...form, entryQrShow: 'before', entryQrHours: '' }).field, 'entryQrHours');
    assert.equal(rules.validateEvent({ ...form, entryQrHours: '200' }).field, 'entryQrHours');
    assert.equal('id_check_providers' in rules.validateEvent(form).fields, false, 'a page from before keeps what is stored');
  });
});

// ---------------------------------------------------------------------------
// Outside providers
// ---------------------------------------------------------------------------

test('a Didit check: started from the account page, read on the way back, and the name becomes the legal name', async () => {
  const otter = await member();
  const offered = await otter.call(idcheck);
  assert.deepEqual(offered.json.idCheck.providers, ['didit', 'veriff']);

  providerAnswers.push([/didit\.me\/v3\/session\/$/, { session_id: 'sess-1', url: 'https://verify.didit.me/session/abc' }]);
  const started = await otter.call(idcheck, { method: 'POST', body: { action: 'start', provider: 'didit', next: '/e/door-meet' } });
  assert.equal(started.json.url, 'https://verify.didit.me/session/abc');
  const sent = JSON.parse(providerCalls[0].init.body);
  assert.equal(sent.vendor_data, account('otter').id);
  assert.match(sent.callback, /\/api\/idcheck\/return\?next=%2Fe%2Fdoor-meet&id=[0-9a-f-]{36}$/);
  const check = db.table('gftvevents_id_checks')[0];
  assert.equal(check.provider_session_id, 'sess-1');

  providerAnswers.push([/decision/, {
    status: 'Approved', vendor_data: account('otter').id,
    id_verifications: [{ full_name: 'Otter Tan Wei Ming', date_of_birth: '1999-04-01', document_number: 'S1234567A', issuing_state: 'SGP' }],
  }]);
  // Didit adds its own "?..." to the address; the id is still read.
  const back = await browser().call(idReturn, { query: { next: '/e/door-meet', id: `${check.id}?verificationSessionId=sess-1` } });
  assert.equal(back.status, 303);
  assert.equal(back.headers.location, '/account?idcheck=done&next=%2Fe%2Fdoor-meet#profile');
  assert.equal(db.table('gftvevents_id_checks')[0].status, 'approved');
  assert.deepEqual(account('otter').id_verified_providers, ['didit']);
  assert.equal(account('otter').legal_name, 'Otter Tan Wei Ming');
  assert.equal(account('otter').date_of_birth, '1999-04-01');
  assert.equal(JSON.stringify(db.table('gftvevents_id_checks')).includes('S1234567A'), false, 'the document number is never kept');

  // The same document cannot verify a second account.
  const fox = await member('fox');
  providerAnswers.length = 0;
  providerAnswers.push([/didit\.me\/v3\/session\/$/, { session_id: 'sess-2', url: 'https://verify.didit.me/session/def' }]);
  await fox.call(idcheck, { method: 'POST', body: { action: 'start', provider: 'didit' } });
  providerAnswers.push([/decision/, {
    status: 'Approved', vendor_data: account('fox').id,
    id_verifications: [{ full_name: 'Fox', date_of_birth: '1999-04-01', document_number: 's1234567a', issuing_state: 'sgp' }],
  }]);
  const refreshed = await fox.call(idcheck, { method: 'POST', body: { action: 'refresh' } });
  assert.deepEqual(refreshed.json.idCheck.latest, { provider: 'didit', status: 'declined', failure: 'document_used' });
  assert.deepEqual(account('fox').id_verified_providers, []);
});

test('a Didit webhook must be signed, and only says which check to read again', async () => {
  const otter = await member();
  providerAnswers.push([/didit\.me\/v3\/session\/$/, { session_id: 'sess-9', url: 'https://verify.didit.me/session/x' }]);
  await otter.call(idcheck, { method: 'POST', body: { action: 'start', provider: 'didit' } });
  // The body claims approval; the provider's own answer says declined.
  providerAnswers.push([/decision/, { status: 'Declined', vendor_data: account('otter').id }]);
  const raw = JSON.stringify({ session_id: 'sess-9', status: 'Approved', webhook_type: 'status.updated' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'didit-secret').update(raw).digest('hex');

  const forged = await browser().call(webhook, { method: 'POST', query: { provider: 'didit' }, body: raw, headers: { 'x-signature': 'f'.repeat(64), 'x-timestamp': timestamp } });
  assert.equal(forged.status, 401);
  assert.equal(db.table('gftvevents_id_checks')[0].status, 'started');

  const signed = await browser().call(webhook, { method: 'POST', query: { provider: 'didit' }, body: raw, headers: { 'x-signature': signature, 'x-timestamp': timestamp } });
  assert.equal(signed.status, 200);
  assert.equal(db.table('gftvevents_id_checks')[0].status, 'declined', 'from the provider, not the body');
  assert.deepEqual(account('otter').id_verified_providers, []);
});

test('a Veriff decision is read with the signed session id', async () => {
  const otter = await member();
  providerAnswers.push([/stationapi\.veriff\.com\/v1\/sessions$/, { status: 'success', verification: { id: 'vf-1', url: 'https://magic.veriff.me/v/abc' } }]);
  await otter.call(idcheck, { method: 'POST', body: { action: 'start', provider: 'veriff' } });
  providerAnswers.push([/vf-1\/decision/, { status: 'success', verification: { code: 9001, vendorData: account('otter').id, person: { firstName: 'Otter', lastName: 'Lim' }, document: { number: 'K1', country: 'MY' } } }]);
  await otter.call(idcheck, { method: 'POST', body: { action: 'refresh' } });
  const decisionCall = providerCalls.find((call) => /decision/.test(call.url));
  assert.equal(decisionCall.init.headers['x-hmac-signature'], createHmac('sha256', 'veriff-secret').update('vf-1').digest('hex'));
  assert.deepEqual(account('otter').id_verified_providers, ['veriff']);
  assert.equal(account('otter').legal_name, 'Otter Lim');
});

test('an admin correcting a verified legal name takes the ID check away', async () => {
  await member();
  Object.assign(account('otter'), { id_verified_providers: ['helloid'], legal_name: 'Otter' });
  const boss = await staff('boss', { is_admin: true });
  const fixed = await boss.call(admin, { method: 'POST', body: { action: 'personal-fix', username: 'otter', legalName: 'Otter Tan' } });
  assert.equal(fixed.status, 200);
  assert.deepEqual(account('otter').id_verified_providers, []);
});

// ---------------------------------------------------------------------------
// HelloID
// ---------------------------------------------------------------------------

test('HelloID: an approved try verifies the account; a waiting one goes to the admins, who decide', async () => {
  await member();
  const otterId = account('otter').id;
  const approved = await helloidChecks.saveHelloid(otterId, { status: 'approved', decided_auto: true, verified_name: 'Otter Tan', verified_birth: '2000-01-02', identity_hash: 'doc-1', face_template: helloidChecks.sealTemplate([0.1, 0.2]) });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(account('otter').id_verified_providers, ['helloid']);
  assert.equal(account('otter').legal_name, 'Otter Tan');
  assert.equal(await helloidChecks.documentUsedElsewhere('doc-1', otterId), false, 'its own document');
  assert.deepEqual((await helloidChecks.otherTemplates(crypto.randomUUID())).map((each) => each.template), [[0.1, 0.2]]);

  await member('fox');
  const foxId = account('fox').id;
  assert.equal(await helloidChecks.documentUsedElsewhere('doc-1', foxId), true);
  const waiting = await helloidChecks.saveHelloid(foxId, { status: 'pending', verified_name: 'Fox', verified_birth: '2001-01-01', findings: { checks: { turns: true } } });
  assert.equal(account('fox').helloid_pending, true);

  // Admins only.
  const editor = await staff('editor', { is_editor: true });
  assert.equal((await editor.call(reviews)).status, 403);
  const boss = await staff('boss', { is_admin: true });
  const list = await boss.call(reviews);
  assert.equal(list.json.reviews.length, 1);
  assert.equal(list.json.reviews[0].username, 'fox');
  assert.equal(JSON.stringify(list.json).includes('@example.com'), false);
  assert.equal((await boss.call(reviews, { method: 'POST', body: { action: 'decline', check: waiting.id } })).json.error, 'helloid_reason_required');
  const declined = await boss.call(reviews, { method: 'POST', body: { action: 'decline', check: waiting.id, reason: 'The photo is blurry.' } });
  assert.deepEqual(declined.json.reviews, []);
  await settle();
  assert.equal(account('fox').helloid_pending, false);
  assert.equal((await helloidChecks.latestHelloid(foxId)).decline_reason, 'The photo is blurry.');
  assert.equal((await boss.call(reviews, { method: 'POST', body: { action: 'approve', check: waiting.id } })).json.error, 'helloid_not_pending');
});

test('HelloID: the challenge is signed, the names compare leniently, and the device is read', async () => {
  const helloid = await import('../api/_lib/helloid.js');
  const challenge = helloid.issueChallenge('account', 'acct-1');
  assert.equal(new Set(challenge.turns).size, 4);
  assert.equal(challenge.flashes.length, 6);
  assert.deepEqual(helloid.readChallenge(challenge.token, 'account', 'acct-1'), { turns: challenge.turns, flashes: challenge.flashes });
  assert.equal(helloid.readChallenge(challenge.token, 'account', 'acct-2'), null, 'someone else\'s');
  const [issued, turnCode, flashCode, nonce, signature] = challenge.token.split('.');
  const otherFlashes = flashCode.split('').reverse().join('');
  if (otherFlashes !== flashCode) {
    assert.equal(helloid.readChallenge([issued, turnCode, otherFlashes, nonce, signature].join('.'), 'account', 'acct-1'), null, 'flashes changed');
  }
  assert.equal(helloid.readChallenge(challenge.token, 'account', 'acct-1', Date.now() + 11 * 60_000), null, 'too old');

  assert.equal(helloid.namesMatch('ERIKSSON<<ANNA<MARIA<<<<<<<<<<', 'Anna Maria Eriksson'), true);
  assert.equal(helloid.namesMatch('ERIKSSON<<ANNACMARTAC<<<<<<<<<', 'Anna María Eriksson'), true, 'a misread filler and letter');
  assert.equal(helloid.namesMatch('TAN<<WEI<MING<<<', 'Anna Eriksson'), false);

  const device = helloid.analyseDevice({ camera: 'OBS Virtual Camera', timeZone: 'Asia/Singapore', cores: 8 }, { headers: { 'user-agent': 'Mozilla/5.0', 'x-vercel-ip-country': 'MY' } }, 'SG');
  assert.deepEqual(device.flags, ['virtual_camera']);
  assert.deepEqual(device.findings.notes, ['ip_country_differs']);
  assert.match(device.hash, /^[A-Za-z0-9_-]{32}$/);
});

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

test('organisers check people in by their QR code, RSVP ID or username; codes cannot be made up', async () => {
  const event = addEvent();
  const otter = await member();
  const going = await join(otter);
  const code = going.json.event.viewer.checkinCode;
  const editor = await staff('editor', { is_editor: true });
  const list = (await editor.call(checkin, { query: { id: event.id } })).json;
  assert.equal(list.attendees[0].fingerprint.length, 64, 'for scanning with no connection');

  const forged = code.replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal((await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: event.id, code: forged } })).json.error, 'checkin_not_found');
  const other = addEvent({ slug: 'other-meet' });
  assert.equal((await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: other.id, code } })).json.error, 'checkin_other_event');

  const scanned = await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: event.id, code } });
  assert.equal(scanned.json.already, false);
  assert.equal(scanned.json.person.checkedInHow, 'scan');
  assert.deepEqual(scanned.json.counts, { going: 1, checkedIn: 1 });
  const again = await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: event.id, query: '@OTTER' } });
  assert.equal(again.json.already, true);
  await editor.call(checkin, { method: 'POST', body: { action: 'undo', id: event.id, rsvpNumber: 1 } });
  assert.equal(db.table('gftvevents_attendees')[0].checked_in_at, null);
  const typed = await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: event.id, query: '#1' } });
  assert.equal(typed.json.person.checkedInHow, 'manual');

  // The person sees it on their pass.
  const page = (await otter.call(detail, { query: { slug: 'door-meet' } })).json.event;
  assert.ok(page.viewer.checkedInAt);
  // A member who edits nothing cannot reach the page.
  assert.equal((await otter.call(checkin, { query: { id: event.id } })).status, 403);
});

test('checking ID at the door is asked before checking someone in, and check-ins made offline sync later', async () => {
  const event = addEvent({ id_check_door: true });
  const otter = await member();
  await join(otter);
  const fox = await member('fox');
  await join(fox);
  const editor = await staff('editor', { is_editor: true });
  const asked = await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: event.id, query: '1' } });
  assert.equal(asked.status, 409);
  assert.equal(asked.json.error, 'id_door_check_needed');
  assert.equal(asked.json.person.username, 'otter');
  const ok = await editor.call(checkin, { method: 'POST', body: { action: 'checkin', id: event.id, query: '1', idChecked: true } });
  assert.ok(ok.json.person.idDoorCheckedAt);

  const at = new Date(Date.now() - 60_000).toISOString();
  const synced = await editor.call(checkin, { method: 'POST', body: { action: 'sync', id: event.id, entries: [
    { rsvpNumber: 2, at, how: 'scan', idChecked: true },
    { rsvpNumber: 1, undo: true },
    { rsvpNumber: 9, at },
  ] } });
  assert.deepEqual(synced.json.results.map((result) => result.ok), [true, true, false]);
  const rows = db.table('gftvevents_attendees');
  assert.equal(rows.find((row) => row.rsvp_number === 2).checked_in_at, at, 'when it happened offline');
  assert.equal(rows.find((row) => row.rsvp_number === 1).checked_in_at, null);
});

test('self check-in: the beacon code works while it is on, for people going, and only for a few minutes', async () => {
  const event = addEvent();
  const otter = await member();
  await join(otter);
  const editor = await staff('editor', { is_editor: true });
  const codeNow = () => new URL(checkinLib.beaconCodesAhead(event.id, event.slug)[0].url).searchParams.get('checkin');

  assert.equal((await otter.call(selfCheckin, { method: 'POST', body: { slug: 'door-meet', code: codeNow() } })).json.error, 'self_checkin_off');
  await editor.call(checkin, { method: 'POST', body: { action: 'beacon', id: event.id, on: true } });
  const ahead = (await editor.call(checkin, { query: { id: event.id, beacon: '1' } })).json.beacon.codes;
  assert.equal(ahead.length, 480, 'four hours of 30-second codes');

  const old = checkinLib.beaconCodesAhead(event.id, event.slug, Date.now() - 6 * 60_000)[0].url;
  assert.equal((await otter.call(selfCheckin, { method: 'POST', body: { slug: 'door-meet', code: new URL(old).searchParams.get('checkin') } })).json.error, 'checkin_code_invalid');
  const other = addEvent({ slug: 'other-meet' });
  const otherCode = new URL(checkinLib.beaconCodesAhead(other.id, other.slug)[0].url).searchParams.get('checkin');
  assert.equal((await otter.call(selfCheckin, { method: 'POST', body: { slug: 'door-meet', code: otherCode } })).json.error, 'checkin_code_invalid');

  const done = await otter.call(selfCheckin, { method: 'POST', body: { slug: 'door-meet', code: codeNow() } });
  assert.equal(done.json.already, false);
  assert.equal(db.table('gftvevents_attendees')[0].checked_in_how, 'self');
  assert.equal((await otter.call(selfCheckin, { method: 'POST', body: { slug: 'door-meet', code: codeNow() } })).json.already, true);

  const fox = await member('fox');
  assert.equal((await fox.call(selfCheckin, { method: 'POST', body: { slug: 'door-meet', code: codeNow() } })).json.error, 'not_going');
});

// ---------------------------------------------------------------------------
// Entry codes
// ---------------------------------------------------------------------------

test('entry codes: one per person in RSVP order, only for those who qualify, and only their own', async () => {
  const event = addEvent({ entry_qr_mode: 'each', entry_qr_audience: 'paid', price_type: 'paid', price_min: 10, currency: 'SGD' });
  for (const position of [0, 1]) {
    await db.from('gftvevents_entry_codes').insert({ event_id: event.id, path: `entry/${event.id}/code${position}aaaaaaaaaaaa.png`, position });
  }
  const otter = await member();
  await join(otter);
  const fox = await member('fox');
  await join(fox);
  const cat = await member('cat');
  await join(cat);

  // Not paid yet: none.
  let page = (await otter.call(detail, { query: { slug: 'door-meet' } })).json.event;
  assert.deepEqual(page.viewer.entry, { state: 'unpaid', url: null, from: null });
  for (const row of db.table('gftvevents_attendees')) {
    row.payment_status = 'paid';
  }
  // Fox asks first, but codes go in RSVP order.
  const foxPage = (await fox.call(detail, { query: { slug: 'door-meet' } })).json.event;
  page = (await otter.call(detail, { query: { slug: 'door-meet' } })).json.event;
  const codes = db.table('gftvevents_entry_codes');
  assert.equal(codes.find((code) => code.position === 0).assigned_to, account('otter').id);
  assert.equal(codes.find((code) => code.position === 1).assigned_to, account('fox').id);
  assert.equal(page.viewer.entry.state, 'ready');
  assert.notEqual(page.viewer.entry.url, foxPage.viewer.entry.url);
  assert.deepEqual((await cat.call(detail, { query: { slug: 'door-meet' } })).json.event.viewer.entry, { state: 'none_left', url: null, from: null });

  // Fox cannot open Otter's code.
  const otterCodeId = new URL(page.viewer.entry.url, 'https://x').searchParams.get('v');
  assert.equal((await fox.call(entryCode, { query: { slug: 'door-meet', v: otterCodeId } })).status, 404);

  // Otter leaves: their code goes to the next person who qualifies.
  await otter.call(rsvp, { method: 'POST', body: { slug: 'door-meet', going: false } });
  const catPage = (await cat.call(detail, { query: { slug: 'door-meet' } })).json.event;
  assert.equal(catPage.viewer.entry.state, 'ready');
  assert.equal(codes.find((code) => code.position === 0).assigned_to, account('cat').id);
});

test('an editor\'s list says who has verified, and the event list says which ID checks this deploy offers', async () => {
  const event = addEvent({ id_check_providers: ['helloid'] });
  const otter = await member();
  account('otter').id_verified_providers = ['helloid'];
  await join(otter);
  const editor = await staff('editor', { is_editor: true });
  const listed = (await editor.call(manage)).json;
  assert.deepEqual(listed.idProviders, ['didit', 'veriff', 'helloid']);
  const opened = (await editor.call(manage, { query: { id: event.id } })).json;
  assert.deepEqual(opened.attendees[0].idCheck, { state: 'verified', via: 'helloid' });
  assert.deepEqual(opened.event.idCheckProviders, ['helloid']);
});

test('without their keys, Didit and Veriff are not offered, and a save drops them', async () => {
  const saved = { didit: process.env.DIDIT_API_KEY, veriff: process.env.VERIFF_API_KEY };
  delete process.env.DIDIT_API_KEY;
  delete process.env.VERIFF_API_KEY;
  try {
    const editor = await staff('editor', { is_editor: true });
    assert.deepEqual((await editor.call(manage)).json.idProviders, ['helloid']);
    const made = await editor.call(manage, {
      method: 'POST',
      body: { action: 'create', event: { title: 'Free Meet', description: 'A', descriptionZh: 'B', kind: 'furmeet', status: 'draft', timezone: 'Asia/Singapore', startDate: '2030-03-01', priceType: 'free', idCheckProviders: ['didit', 'veriff', 'helloid'] } },
    });
    assert.deepEqual(made.json.event.idCheckProviders, ['helloid']);
    const otter = await member();
    assert.deepEqual((await otter.call(idcheck)).json.idCheck.providers, []);
    assert.equal((await otter.call(idcheck, { method: 'POST', body: { action: 'start', provider: 'didit' } })).json.error, 'id_provider_unavailable');
  } finally {
    process.env.DIDIT_API_KEY = saved.didit;
    process.env.VERIFF_API_KEY = saved.veriff;
  }
});
