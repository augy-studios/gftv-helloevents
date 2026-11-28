// Picking HelloID's face model: scripts/helloid-face-bakeoff.js with a
// stand-in for the models (no photos of anyone), the HELLOID_FACE_* settings
// (helloid.js faceSetup), and face templates kept with the model that made
// them (helloid-checks.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.TOTP_ENCRYPTION_KEY = 'd'.repeat(64);
process.env.SUPABASE_URL = 'https://project.supabase.co';

const bakeoff = await import('../scripts/helloid-face-bakeoff.js');
const helloid = await import('../api/_lib/helloid.js');
const checks = await import('../api/_lib/helloid-checks.js');
const { decryptSecret } = await import('../api/_lib/crypto.js');

let seed = 5;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

test('the equal error rate is where refusing the same person meets accepting different people', () => {
  assert.deepEqual(bakeoff.equalErrorRate([0.8, 0.9, 0.7, 0.85], [0.1, 0.2, 0.3, 0.75]), { rate: 0.25, threshold: 0.75 });
  assert.deepEqual(bakeoff.equalErrorRate([0.8, 0.9], [0.1, 0.2]).rate, 0);
  assert.equal(bakeoff.equalErrorRate([], [0.1]), null);
});

test('the bake-off picks the model that tells people apart best, with its settings', async () => {
  // 30 people, each an ID photo and two selfies. Each "photo" is the
  // person's face, which a sharp model sees nearly the same every time and
  // a blurry one does not.
  const faces = Array.from({ length: 30 }, () => Array.from({ length: 32 }, () => random() - 0.5));
  const people = faces.map((face, person) => ({
    images: [{ kind: 'id', bytes: { person } }, { kind: 'live', bytes: { person } }, { kind: 'live', bytes: { person } }],
  }));
  // One person's ID photo shows no face.
  people[0].images[0].bytes = { person: 0, noFace: true };
  const noise = { sharp: 0.05, blurry: 2.5 };
  const templateOf = async (model, bytes) => {
    if (bytes.noFace) {
      return null;
    }
    return faces[bytes.person].map((value) => value + (random() - 0.5) * noise[model]);
  };
  const report = await bakeoff.bakeoff(people, ['blurry', 'sharp'], templateOf);
  assert.equal(report.best, 'sharp');
  assert.equal(report.results.sharp.noFace, 1);
  assert.equal(report.results.sharp.samePerson.n, 29 * 2, 'ID against selfie, but not the ID with no face');
  assert.equal(report.results.sharp.differentPeople.n, 29 * 29 * 2);
  assert.equal(report.results.sharp.sameFrames.n, 30);
  assert.ok(report.results.sharp.equalError.rate < report.results.blurry.equalError.rate);
  assert.equal(report.results.sharp.samePass, 1);
  assert.ok(report.results.sharp.differentPass <= 0.001);
  assert.ok(report.results.sharp.samePersonSetting > 0.5);
  assert.deepEqual(report.warnings, []);
  const text = bakeoff.printBakeoff(report);
  assert.match(text, /Best: sharp/);
  assert.match(text, /HELLOID_FACE_MODEL=sharp/);
  assert.match(text, /HELLOID_FACE_MATCH=0\.\d+/);
  assert.match(text, /fetch-face-models\.js --into api\/_lib\/models\/face sharp/);
  // Too few people: said so.
  const few = await bakeoff.bakeoff(people.slice(0, 5), ['sharp'], templateOf);
  assert.ok(few.warnings.some((warning) => warning.includes('only 5 people')));
});

test('the photos are read one folder per person, ID photos by name', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'helloid-bakeoff-'));
  try {
    await mkdir(path.join(folder, 'person-01'));
    await mkdir(path.join(folder, 'person-02'));
    await writeFile(path.join(folder, 'person-01', 'ID-passport.jpg'), 'a');
    await writeFile(path.join(folder, 'person-01', 'selfie.png'), 'b');
    await writeFile(path.join(folder, 'person-01', 'notes.txt'), 'not a photo');
    await writeFile(path.join(folder, 'person-02', 'selfie.webp'), 'c');
    await writeFile(path.join(folder, 'stray.jpg'), 'not in a person\'s folder');
    const people = await bakeoff.readPeople(folder);
    assert.deepEqual(people.map((person) => person.images.map((image) => image.kind)), [['id', 'live'], ['live']]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a face model other than FaceRes needs thresholds of its own', () => {
  assert.deepEqual(helloid.faceSetup({}), { model: 'faceres', faceMatch: 0.55, samePerson: 0.45, problem: null });
  assert.deepEqual(helloid.faceSetup({ HELLOID_FACE_MODEL: 'mobilefacenet', HELLOID_FACE_MATCH: '0.42', HELLOID_SAME_PERSON: '0.38' }), { model: 'mobilefacenet', faceMatch: 0.42, samePerson: 0.38, problem: null });
  const missing = helloid.faceSetup({ HELLOID_FACE_MODEL: 'faceres-deep' });
  assert.equal(missing.model, 'faceres');
  assert.match(missing.problem, /needs HELLOID_FACE_MATCH and HELLOID_SAME_PERSON/);
  assert.equal(helloid.faceSetup({ HELLOID_FACE_MODEL: 'faceres-deep', HELLOID_FACE_MATCH: '1.5', HELLOID_SAME_PERSON: '0.4' }).model, 'faceres');
  const unknown = helloid.faceSetup({ HELLOID_FACE_MODEL: 'arcface' });
  assert.equal(unknown.model, 'faceres');
  assert.match(unknown.problem, /not one of faceres, faceres-deep, mobilefacenet/);
  assert.equal(helloid.CURRENT_THRESHOLDS.model, 'faceres');
});

test('face templates are kept with the model that made them; old ones were FaceRes\'s', () => {
  const sealed = checks.sealTemplate([0.123456, -0.5], 'mobilefacenet');
  assert.deepEqual(checks.openTemplate(decryptSecret(sealed)), { template: [0.1235, -0.5], model: 'mobilefacenet' });
  assert.deepEqual(checks.openTemplate('[0.1,0.2]'), { template: [0.1, 0.2], model: 'faceres' }, 'kept before models were named');
  assert.equal(checks.sealTemplate(null, 'faceres'), null, 'no face on the first frame: nothing to keep (it used to throw)');
  assert.equal(checks.openTemplate('not json'), null);
  assert.equal(checks.openTemplate('{"values":[1]}'), null);
});
