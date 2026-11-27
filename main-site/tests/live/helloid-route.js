// A HelloID submission through api/me/helloid.js, against the in-memory
// database, with the real face models and OCR (slow: not part of npm test).
// The pictures are a still face and copies of it, so the turns fail and the
// check waits for review: what matters is that every step runs.
//   node tests/live/helloid-route.js <face.jpg> [id-photo.jpg]
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { browser } from '../harness.js';
import { createFakeDb } from '../fake-db.js';

process.env.TOTP_ENCRYPTION_KEY = 'b'.repeat(64);
const [facePath, idPath] = process.argv.slice(2);
if (!facePath) {
  console.log('usage: node tests/live/helloid-route.js <face.jpg> [id-photo.jpg]');
  process.exit(1);
}

const { useTestClient } = await import('../../api/_lib/supabase.js');
const db = createFakeDb();
useTestClient(db);
const signup = (await import('../../api/auth/signup.js')).default;
const helloid = (await import('../../api/me/helloid.js')).default;
const reviews = (await import('../../api/manage/helloid.js')).default;

const b = browser();
const joined = await b.call(signup, { method: 'POST', body: { username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: 'correct horse battery', country: 'SG', agree: true } });
assert.equal(joined.status, 200, JSON.stringify(joined.json));
const standing = await b.call(helloid, { headers: { 'x-vercel-ip-country': 'MY' } });
console.log('standing', JSON.stringify(standing.json.helloid));
assert.equal(standing.json.helloid.country, 'MY');

const face = (await readFile(facePath)).toString('base64');
let front = face;
if (idPath) {
  front = (await readFile(idPath)).toString('base64');
}
const { challenge } = (await b.call(helloid, { query: { challenge: '1' } })).json;
const t0 = Date.now();
const read = await b.call(helloid, { method: 'POST', body: { action: 'read', country: 'SG', type: 'passport', front } });
console.log('read', read.status, JSON.stringify(read.json), `${Date.now() - t0}ms`);
const submitted = await b.call(helloid, {
  method: 'POST',
  headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 15)', 'x-vercel-ip-country': 'SG' },
  body: {
    action: 'submit', consent: true, country: 'SG', type: 'passport', front, challenge: challenge.token,
    name: 'Otter Tan', birth: '2000-01-02', neutral: face,
    turns: challenge.turns.map(() => [face, face]), flashes: challenge.flashes.map(() => face),
    device: { camera: 'Front Camera', timeZone: 'Asia/Singapore', screen: '412x915', platform: 'Android', cores: 8, touch: true },
  },
});
console.log('submit', submitted.status, `${Date.now() - t0}ms`, JSON.stringify(submitted.json.helloid));
assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
const row = db.table('gftvevents_helloid_checks')[0];
console.log('stored', row.status, 'photos', Boolean(row.id_photo_path), Boolean(row.selfie_path), 'template', Boolean(row.face_template), 'device', row.device_hash);
console.log('findings', JSON.stringify(row.findings));
assert.equal(db.table('gftvevents_accounts')[0].helloid_pending, row.status === 'pending');
console.log('reviews route loads:', typeof reviews);
process.exit(0);
