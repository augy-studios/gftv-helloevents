// The HelloID tuning report (api/_lib/helloid-calibration.js): HelloID's thresholds from its own decided
// checks and approved face templates, against the in-memory database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOTP_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { createFakeDb } = await import('./fake-db.js');
const { encryptSecret } = await import('../api/_lib/crypto.js');
const calibration = await import('../api/_lib/helloid-calibration.js');
const { CURRENT_THRESHOLDS } = await import('../api/_lib/helloid.js');

let seed = 11;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
// A face template: a random direction, so two people's are about 0 alike.
const template = () => Array.from({ length: 64 }, () => random() - 0.5);
// The same face again, a little different.
const near = (base) => base.map((value) => value + (random() - 0.5) * 0.05);

function findings({ faceMatch, yaw, pitch, flashes, framesLowest }) {
  return {
    checks: {},
    faceMatch,
    real: 0.9,
    live: 0.8,
    framesLowest,
    turns: { left: { yaw, pitch: 2 }, right: { yaw: -yaw - 3, pitch: 1 }, up: { yaw: 1, pitch }, down: { yaw: -2, pitch: -pitch - 2 } },
    flashes: { matched: flashes, of: 6 },
  };
}

test('scores come out of the findings as helloid.js holds them to its thresholds', () => {
  const scores = calibration.scoresOf(findings({ faceMatch: 0.71, yaw: 22, pitch: 14, flashes: 6, framesLowest: 0.66 }));
  assert.deepEqual(scores, { faceMatch: 0.71, real: 0.9, live: 0.8, framesLowest: 0.66, turnYaw: 22, turnPitch: 14, flashes: 6 });
  assert.deepEqual(calibration.scoresOf(null), {});
  assert.equal(calibration.outcomeOf({ status: 'approved', decided_auto: true }), 'auto');
  assert.equal(calibration.outcomeOf({ status: 'approved', decided_auto: false, reviewed_by: 'admin' }), 'approved');
  assert.equal(calibration.outcomeOf({ status: 'declined', reviewed_by: 'admin' }), 'declined');
  assert.equal(calibration.outcomeOf({ status: 'declined', reviewed_by: null }), null, 'declined without an admin: a used document');
  assert.equal(calibration.outcomeOf({ status: 'pending' }), null);
});

test('spreads, the best cut and the face threshold', () => {
  assert.deepEqual(calibration.spread([3, 1, 2]), { n: 3, min: 1, p5: 1.1, p25: 1.5, median: 2, p75: 2.5, p95: 2.9, max: 3 });
  assert.deepEqual(calibration.bestCut([0.7, 0.8, 0.9], [0.2, 0.3, 0.75]), { cut: 0.7, genuinePass: 1, othersPass: 0.33 });
  assert.equal(calibration.bestCut([], [1]), null);
  // 1000 pairs, at most 1 in 1000 allowed above: just above the second highest.
  const scores = Array.from({ length: 1000 }, (unused, index) => index / 2000).sort((left, right) => left - right);
  assert.equal(calibration.faceThreshold(scores, 0.001), 0.5);
  assert.equal(calibration.faceThreshold([], 0.001), null);
});

test('the report reads every check, compares different accounts\' faces and suggests settings', async () => {
  const db = createFakeDb();
  useTestClient(db);
  const accounts = [];
  for (let index = 0; index < 60; index += 1) {
    const row = { id: crypto.randomUUID(), kind: 'public', username: `member${index}`, display_name: `Member ${index}`, status: 'active' };
    await db.from('gftvevents_accounts').insert(row);
    accounts.push(row.id);
  }
  const twin = template();
  const checks = [];
  for (let index = 0; index < 50; index += 1) {
    // Account 49 is account 48 again: the same face on two accounts.
    let face = template();
    if (index === 48) {
      face = twin;
    }
    if (index === 49) {
      face = near(twin);
    }
    checks.push({
      account_id: accounts[index], status: 'approved', decided_auto: index % 2 === 0, reviewed_by: null,
      findings: findings({ faceMatch: 0.62 + random() * 0.3, yaw: 18 + random() * 20, pitch: 12 + random() * 12, flashes: 5 + Math.round(random()), framesLowest: 0.6 + random() * 0.3 }),
      face_template: encryptSecret(JSON.stringify(face)),
    });
  }
  for (let index = 50; index < 60; index += 1) {
    checks.push({
      account_id: accounts[index], status: 'declined', decided_auto: false, reviewed_by: accounts[0],
      findings: findings({ faceMatch: 0.2 + random() * 0.3, yaw: 3 + random() * 8, pitch: 2 + random() * 5, flashes: Math.round(random() * 3), framesLowest: 0.3 }),
      face_template: null,
    });
  }
  checks.push({ account_id: accounts[0], status: 'pending', decided_auto: false, reviewed_by: null, findings: findings({ faceMatch: 0.5, yaw: 10, pitch: 5, flashes: 3, framesLowest: 0.5 }), face_template: null });
  await db.from('gftvevents_helloid_checks').insert(checks);

  const { rows, templates } = await calibration.load();
  assert.equal(rows.length, 61);
  assert.equal(templates.length, 50, 'approved ones only, decrypted');
  const report = calibration.calibrate(rows, templates, { current: CURRENT_THRESHOLDS });
  assert.deepEqual(report.counts, { approvedByChecks: 25, approvedByAdmin: 25, declinedByAdmin: 10, templates: 50 });
  assert.equal(report.face.differentPeople.pairs, 50 * 49 / 2);
  // Random faces are about 0 alike; the twin pair is found above FACE_MATCH.
  assert.ok(report.face.differentPeople.median < 0.2);
  assert.equal(report.face.pairsAboveCurrent, 1);
  assert.equal(report.pairsAbove(CURRENT_THRESHOLDS.faceMatch).length, 1);
  assert.ok(report.metrics.faceMatch.separation.genuinePass === 1);
  assert.ok(report.metrics.faceMatch.separation.othersPass === 0);
  // Approved turns start at 18 and 12 degrees; 5% of them lower.
  assert.ok(report.suggestions.TURN_YAW_DEGREES >= 18 && report.suggestions.TURN_YAW_DEGREES <= 20, String(report.suggestions.TURN_YAW_DEGREES));
  assert.ok(report.suggestions.TURN_PITCH_DEGREES >= 12 && report.suggestions.TURN_PITCH_DEGREES <= 14);
  assert.equal(report.suggestions.FLASHES_NEEDED, 5);
  assert.ok(report.suggestions.SAME_PERSON > 0.5 && report.suggestions.SAME_PERSON < 0.65, String(report.suggestions.SAME_PERSON));
  // 1225 pairs: enough. At 1 in 1000, the one pair allowed above is the
  // twin, so the suggestion sits just above the random faces.
  assert.equal(report.warnings.some((warning) => warning.code === 'few_pairs'), false);
  assert.ok(report.face.differentPeopleBelow > 0.2 && report.face.differentPeopleBelow < 0.55, String(report.face.differentPeopleBelow));
  // FACE_MATCH is never suggested lower than it is.
  assert.equal(report.suggestions.FACE_MATCH, CURRENT_THRESHOLDS.faceMatch);
  assert.equal(report.face.suggestedGenuinePass, 1);
  // Fewer pairs than that: a warning.
  const few = calibration.calibrate(rows, templates.slice(0, 20), { current: CURRENT_THRESHOLDS });
  assert.deepEqual(few.warnings.find((warning) => warning.code === 'few_pairs'), { code: 'few_pairs', count: 190, want: 1000 });
  assert.match(calibration.printReport(few), /only 190 pairs of different people/);
  const text = calibration.printReport(report);
  assert.match(text, /Suggested settings/);
  assert.match(text, /1 pairs of accounts score above FACE_MATCH/);
  assert.equal(text.includes('member'), false, 'no usernames');
});

test('FACE_MATCH is raised when different people score too alike for it', () => {
  // Faces that all look much the same to the model: different accounts
  // score about 0.9 alike, above FACE_MATCH.
  const base = template();
  const templates = Array.from({ length: 50 }, (unused, index) => ({ checkId: `check${index}`, accountId: `account${index}`, template: base.map((value) => value + (random() - 0.5) * 0.3) }));
  const rows = templates.map(() => ({ status: 'approved', decided_auto: true, findings: findings({ faceMatch: 0.95, yaw: 25, pitch: 15, flashes: 6, framesLowest: 0.8 }) }));
  const report = calibration.calibrate(rows, templates, { current: CURRENT_THRESHOLDS });
  assert.ok(report.face.currentFalseMatchRate > 0.5, 'most different people pass now');
  assert.ok(report.suggestions.FACE_MATCH > CURRENT_THRESHOLDS.faceMatch, String(report.suggestions.FACE_MATCH));
  assert.ok(report.face.suggestedFalseMatchRate <= 0.001);
});
