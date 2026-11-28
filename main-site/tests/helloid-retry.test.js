// HelloID asking again instead of giving up (api/me/helloid.js): a clearer
// photo when the ID's machine-readable zone was not read clearly, and the
// face part again (with advice) when it did not pass, before a check goes to
// the admins; and the admins' tuning report (api/manage/helloid.js). The
// face models and OCR are stood in for (helloid.js useTestChecks).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.TOTP_ENCRYPTION_KEY = 'e'.repeat(64);
process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const helloid = await import('../api/_lib/helloid.js');
const { MAX_FACE_TRIES, signHistory, readHistory } = await import('../api/me/helloid.js');
const { identityHashOf } = await import('../api/_lib/id-checks.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const { totpAt } = await import('../api/_lib/totp.js');
const signup = await route('auth/signup');
const login = await route('auth/login');
const verify = await route('auth/verify');
const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const me = await route('me/helloid');
const reviews = await route('manage/helloid');

let db;
let analyses;
let mrz;
const picture = `data:image/jpeg;base64,${(await sharp({ create: { width: 320, height: 240, channels: 3, background: '#a08070' } }).jpeg().toBuffer()).toString('base64')}`;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  analyses = [];
  mrz = { found: false };
  helloid.useTestChecks({
    readMrz: async () => mrz,
    analyse: async () => analyses.shift(),
  });
});

async function member(username = 'otter') {
  const b = browser();
  const joined = await b.call(signup, { method: 'POST', body: { username, displayName: 'Otter', email: `${username}@example.com`, password: 'correct horse battery', country: 'SG', agree: true } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  return b;
}

// What helloid.js analyse gives: these checks failed, the rest passed.
// notes: helloid.js's (id_no_face, when the ID photo shows no face).
function outcome(failed, { documentNumber = null, notes = [] } = {}) {
  const checks = {};
  for (const check of ['turns', 'flashes', 'samePerson', 'faceMatch', 'mrz']) {
    checks[check] = !failed.includes(check);
  }
  if (failed.includes('live')) {
    checks.live = false;
  }
  return {
    approve: failed.length === 0,
    findings: { checks, notes, faceModel: 'faceres' },
    template: [0.1, 0.2, 0.3],
    faceModel: 'faceres',
    documentNumber,
    documentCountry: documentNumber ? 'SGP' : null,
  };
}

// history: the signed record of earlier goes the last retry gave.
async function submit(b, history = null) {
  const { challenge } = (await b.call(me, { query: { challenge: '1' } })).json;
  return b.call(me, {
    method: 'POST',
    body: {
      action: 'submit', consent: true, country: 'SG', type: 'passport', front: picture, name: 'Otter Tan', birth: '1999-02-03',
      challenge: challenge.token, faceHistory: history, neutral: picture, turns: [[picture, picture], [picture, picture], [picture, picture], [picture, picture]],
      flashes: Array.from({ length: 6 }, () => picture), device: { camera: 'Front Camera' },
    },
  });
}

test('the read says whether the zone was clear, so the page can ask for a clearer photo', async () => {
  const b = await member();
  const read = () => b.call(me, { method: 'POST', body: { action: 'read', country: 'SG', type: 'passport', front: picture } });
  assert.deepEqual((await read()).json, { ok: true, read: null, zone: 'none' });
  mrz = { found: true, name: 'OTTER TAN', birth: '1999-02-03', birthChecked: true, expiryChecked: true, documentChecked: false, ambiguous: true };
  assert.deepEqual((await read()).json, { ok: true, read: { name: 'Otter Tan', birth: '1999-02-03' }, zone: 'unclear' });
  mrz = { ...mrz, documentChecked: true, ambiguous: false };
  assert.equal((await read()).json.zone, 'clear');
  mrz = { found: true, name: 'OTTER TAN', birth: null, birthChecked: false, expiryChecked: true, documentChecked: true };
  assert.deepEqual((await read()).json, { ok: true, read: null, zone: 'unclear' });
});

test('a face part that does not pass is asked for again, with why, then goes to the admins with how many goes it took', async () => {
  const b = await member();
  analyses.push(outcome(['flashes']), outcome(['turns', 'flashes']), outcome(['flashes']));
  const first = await submit(b);
  const { history, ...retry } = first.json.retry;
  assert.deepEqual(retry, { reason: 'flashes', tries: 1, of: MAX_FACE_TRIES });
  assert.equal(db.table('gftvevents_helloid_checks').length, 0, 'nothing kept');
  const second = await submit(b, history);
  assert.equal(second.json.retry.reason, 'turns');
  assert.equal(second.json.retry.tries, 2);
  // The last go is decided as always: the admins look at it, and see the goes.
  const third = await submit(b, second.json.retry.history);
  assert.equal(third.json.retry, undefined);
  assert.equal(third.json.helloid.pending, true);
  const checks = db.table('gftvevents_helloid_checks');
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].findings.faceTries, { count: 3, earlier: ['flashes', 'turns'] });
  const audits = db.table('gftvevents_audit_logs').filter((row) => row.action === 'helloid.face_retry');
  assert.deepEqual(audits.map((row) => row.details), [{ failed: ['flashes'], try: 1 }, { failed: ['turns', 'flashes'], try: 2 }]);
});

test('the record of earlier goes is signed: another account\'s, a changed or an old one counts as none', async () => {
  const otterId = 'acct-otter';
  const token = signHistory(otterId, ['flashes', 'turns']);
  assert.deepEqual(readHistory(token, otterId), ['flashes', 'turns']);
  assert.deepEqual(readHistory(token, 'acct-beaver'), [], 'another account');
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ a: otterId, r: [], t: Date.now() })).toString('base64url');
  assert.deepEqual(readHistory(`${forged}.${signature}`, otterId), [], 'changed');
  assert.deepEqual(readHistory(`${payload}.${signature}x`, otterId), []);
  assert.deepEqual(readHistory(token, otterId, Date.now() + 31 * 60_000), [], 'old');
  assert.deepEqual(readHistory(undefined, otterId), []);
  assert.deepEqual(readHistory(signHistory(otterId, ['flashes', 'bogus']), otterId), ['flashes']);
  // Sent to the route, a record that does not hold is the first go.
  const b = await member();
  analyses.push(outcome(['flashes']));
  const answer = await submit(b, signHistory('someone-else', ['flashes', 'flashes']));
  assert.equal(answer.json.retry.tries, 1);
});

test('no face, or not the same face, asks to stay in view; a weak ID match is asked about once, glasses off', async () => {
  const b = await member();
  analyses.push(outcome(['live', 'turns', 'flashes', 'samePerson', 'faceMatch', 'mrz']));
  assert.equal((await submit(b)).json.retry.reason, 'face');
  analyses.push(outcome(['samePerson']));
  assert.equal((await submit(b)).json.retry.reason, 'face');
  // The face part passed, the ID photo did not match: once more, then the admins.
  analyses.push(outcome(['faceMatch']), outcome(['faceMatch']));
  const weak = await submit(b);
  assert.equal(weak.json.retry.reason, 'match');
  const again = await submit(b, weak.json.retry.history);
  assert.equal(again.json.retry, undefined, 'asked once only');
  assert.equal(again.json.helloid.pending, true);
  // No face on the ID photo at all: redoing the face part cannot help.
  const c = await member('beaver');
  analyses.push(outcome(['faceMatch'], { notes: ['id_no_face'] }));
  const noFace = await submit(c);
  assert.equal(noFace.json.retry, undefined);
  assert.equal(noFace.json.helloid.pending, true);
});

test('a document already used on another account is declined, face part or not', async () => {
  const other = await member('beaver');
  const beaverId = db.table('gftvevents_accounts').find((row) => row.username === 'beaver').id;
  await db.from('gftvevents_helloid_checks').insert({ account_id: beaverId, status: 'approved', decided_auto: true, identity_hash: identityHashOf({ documentNumber: 'E1234567A', documentCountry: 'SGP' }), findings: {} });
  assert.ok(other);
  const b = await member();
  analyses.push(outcome(['flashes'], { documentNumber: 'E1234567A' }));
  const sent = await submit(b);
  assert.equal(sent.json.retry, undefined);
  assert.equal(sent.json.helloid.latest.failure, 'document_used');
});

test('admins see the tuning report: scores and suggestions, never a photo or a name', async () => {
  await db.from('gftvhello_users').insert({
    username: 'boss', display_name: 'Boss', email: 'boss@gftv.example', password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true, is_admin: true, is_editor: true, totp_secret: SHARED_SECRET,
  });
  const admin = browser();
  const started = await admin.call(login, { method: 'POST', body: { identifier: 'boss', password: PASSWORD } });
  await admin.call(verify, { method: 'POST', body: { challenge: started.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  const b = await member();
  const memberId = db.table('gftvevents_accounts').find((row) => row.username === 'otter').id;
  await db.from('gftvevents_helloid_checks').insert({
    account_id: memberId, status: 'approved', decided_auto: true, reviewed_by: null,
    findings: { checks: {}, faceMatch: 0.8, framesLowest: 0.7, flashes: { matched: 6, of: 6 }, turns: { left: { yaw: 20, pitch: 1 }, right: { yaw: -22, pitch: 0 }, up: { yaw: 0, pitch: 14 }, down: { yaw: 1, pitch: -15 } } },
  });
  // Not for members.
  assert.equal((await b.call(reviews, { query: { tuning: '1' } })).status, 403);
  const answer = await admin.call(reviews, { query: { tuning: '1' } });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  const tuning = answer.json.tuning;
  assert.deepEqual(Object.keys(tuning).sort(), ['counts', 'current', 'face', 'metrics', 'suggestions', 'warnings']);
  assert.deepEqual(tuning.counts, { approvedByChecks: 1, approvedByAdmin: 0, declinedByAdmin: 0, templates: 0 });
  assert.equal(tuning.current.model, 'faceres');
  assert.equal(tuning.metrics.faceMatch.approvedByChecks.median, 0.8);
  assert.deepEqual(tuning.warnings.map((warning) => warning.code), ['few_approved', 'few_pairs', 'few_declined']);
  const text = JSON.stringify(tuning);
  assert.equal(text.includes('otter'), false, 'no usernames');
  assert.equal(text.includes(memberId), false, 'no account ids');
});
