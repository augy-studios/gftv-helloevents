// HelloID's thresholds (helloid.js) set from its own checks instead of
// guesses: shown to admins on /manage's HelloID tuning tab (
// api/manage/helloid.js ?tuning=1), and printed by
// scripts/helloid-calibrate.js. It only reads, and never sees a photo:
// HelloID deletes those once a check is decided.
//
// What it reads, from gftvevents_helloid_checks, for the face model in use:
//   - each decided check's findings (helloid.js analyse): the face match
//     score (ID photo against the live face), the head turns' angles, the
//     flashes matched, the anti-spoof and liveness scores, and the lowest
//     likeness of a frame to the live face (framesLowest);
//   - how it was decided: approved by the checks, or by an admin, or
//     declined by an admin. An admin's decision is the answer the scores
//     are held to;
//   - the face templates of approved checks (decrypted with
//     TOTP_ENCRYPTION_KEY), compared across different accounts: how alike
//     two different people's faces score. That is what a face threshold
//     must stay above.
//
// What it gives: each score's spread for approved and declined checks, and
// a suggested threshold with what it would have done to the checks so far.
// Turn, flash and same-person settings follow the approved checks (all but
// the 5% or 2% least clear of them pass); FACE_MATCH is only ever raised.
// With fewer than MIN_APPROVED approved checks, or MIN_PAIRS pairs of
// different people, the suggestions are marked as too early to trust.

import { database, TABLES } from './supabase.js';
import { decryptSecret } from './crypto.js';
import { openTemplate } from './helloid-checks.js';

export const MIN_APPROVED = 30;
export const MIN_PAIRS = 1000;
const MAX_TEMPLATES = 3000;
// On a Vercel function: about half a million pairs, a few seconds.
export const SERVER_TEMPLATES = 1000;

// The value at a quantile (0 to 1) of sorted numbers, interpolated.
export function quantile(sorted, share) {
  if (sorted.length === 0) {
    return null;
  }
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  const above = Math.ceil(at);
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
}

function round(value, places = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 10 ** places) / 10 ** places;
}

// { n, min, p5, p25, median, p75, p95, max } of some numbers.
export function spread(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p5: round(quantile(sorted, 0.05)),
    p25: round(quantile(sorted, 0.25)),
    median: round(quantile(sorted, 0.5)),
    p75: round(quantile(sorted, 0.75)),
    p95: round(quantile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

// How each check was decided: "auto" (approved by the checks), "approved"
// (by an admin), "declined" (by an admin), or null (pending, or declined
// without an admin, as a document used on another account).
export function outcomeOf(row) {
  if (row.status === 'approved') {
    if (row.decided_auto === true) {
      return 'auto';
    }
    return 'approved';
  }
  if (row.status === 'declined' && row.reviewed_by) {
    return 'declined';
  }
  return null;
}

// The numbers in one check's findings that thresholds apply to. Turns: the
// weaker of the two sideways turns (yaw) and of the two vertical ones
// (pitch), in degrees, as helloid.js holds each to its threshold.
export function scoresOf(findings) {
  const scores = {};
  if (!findings || typeof findings !== 'object') {
    return scores;
  }
  for (const name of ['faceMatch', 'real', 'live', 'framesLowest']) {
    if (typeof findings[name] === 'number') {
      scores[name] = findings[name];
    }
  }
  if (findings.faceTries && typeof findings.faceTries.count === 'number') {
    scores.faceGoes = findings.faceTries.count;
  }
  const turns = findings.turns;
  if (turns && typeof turns === 'object') {
    const angle = (turn, axis) => {
      if (!turns[turn] || typeof turns[turn][axis] !== 'number') {
        return null;
      }
      return Math.abs(turns[turn][axis]);
    };
    const sideways = [angle('left', 'yaw'), angle('right', 'yaw')];
    const vertical = [angle('up', 'pitch'), angle('down', 'pitch')];
    if (sideways.every((value) => value !== null)) {
      scores.turnYaw = Math.min(...sideways);
    }
    if (vertical.every((value) => value !== null)) {
      scores.turnPitch = Math.min(...vertical);
    }
  }
  if (findings.flashes && typeof findings.flashes.matched === 'number') {
    scores.flashes = findings.flashes.matched;
  }
  return scores;
}

// The threshold that best separates two groups where higher means genuine
// (Youden's J: the share of genuine at or above it, less the share of the
// others at or above it). null when either group is empty.
export function bestCut(genuine, others) {
  if (genuine.length === 0 || others.length === 0) {
    return null;
  }
  const candidates = [...new Set([...genuine, ...others])].sort((left, right) => left - right);
  let best = null;
  for (const cut of candidates) {
    const passed = genuine.filter((value) => value >= cut).length / genuine.length;
    const leaked = others.filter((value) => value >= cut).length / others.length;
    const score = passed - leaked;
    if (best === null || score > best.score) {
      best = { cut, score, passed, leaked };
    }
  }
  return { cut: round(best.cut), genuinePass: round(best.passed), othersPass: round(best.leaked) };
}

// How alike different people score: every pair of approved templates from
// different accounts (at most `most` templates, the newest), sorted.
// -> { scores, pairsAbove(threshold) }
export function differentPeople(templates, most = MAX_TEMPLATES) {
  const kept = templates.slice(0, most);
  const scores = [];
  const pairs = [];
  for (let first = 0; first < kept.length; first += 1) {
    for (let second = first + 1; second < kept.length; second += 1) {
      if (kept[first].accountId === kept[second].accountId) {
        continue;
      }
      const score = cosine(kept[first].template, kept[second].template);
      if (score === null) {
        continue;
      }
      scores.push(score);
      pairs.push({ score, checks: [kept[first].checkId, kept[second].checkId] });
    }
  }
  scores.sort((left, right) => left - right);
  return { scores, pairsAbove: (threshold) => pairs.filter((pair) => pair.score >= threshold).sort((left, right) => right.score - left.score) };
}

// The lowest threshold, in steps of 0.01, that at most targetRate of the
// different-people pairs reach. With no pairs, null.
export function faceThreshold(impostorScores, targetRate) {
  if (impostorScores.length === 0) {
    return null;
  }
  const allowed = Math.floor(impostorScores.length * targetRate);
  // The score that `allowed` pairs are above: the (n - allowed)th lowest.
  const index = Math.max(0, impostorScores.length - allowed - 1);
  return Math.ceil((impostorScores[index] + 1e-9) * 100) / 100;
}

// The whole report, from rows of gftvevents_helloid_checks (findings
// parsed) and the decrypted templates [{ checkId, accountId, template }].
// current: helloid.js's thresholds now.
export function calibrate(rows, templates, { current, targetFmr = 0.001, maxTemplates = MAX_TEMPLATES } = {}) {
  const groups = { auto: [], approved: [], declined: [] };
  for (const row of rows) {
    const outcome = outcomeOf(row);
    if (outcome) {
      groups[outcome].push(scoresOf(row.findings));
    }
  }
  const approvedAll = [...groups.auto, ...groups.approved];
  const valuesOf = (list, name) => list.map((scores) => scores[name]).filter((value) => typeof value === 'number');
  const metrics = {};
  for (const name of ['faceMatch', 'framesLowest', 'turnYaw', 'turnPitch', 'flashes', 'faceGoes', 'real', 'live']) {
    metrics[name] = {
      approvedByChecks: spread(valuesOf(groups.auto, name)),
      approvedByAdmin: spread(valuesOf(groups.approved, name)),
      declinedByAdmin: spread(valuesOf(groups.declined, name)),
      separation: null,
    };
    // Higher is clearer for every score but the goes it took.
    if (name !== 'faceGoes') {
      metrics[name].separation = bestCut(valuesOf(approvedAll, name), valuesOf(groups.declined, name));
    }
  }

  const people = differentPeople(templates, maxTemplates);
  const suggestedFace = faceThreshold(people.scores, targetFmr);
  const passRate = (values, threshold) => {
    if (values.length === 0 || threshold === null) {
      return null;
    }
    return round(values.filter((value) => value >= threshold).length / values.length);
  };
  const genuineFace = valuesOf(approvedAll, 'faceMatch');
  const face = {
    differentPeople: { pairs: people.scores.length, ...spread(people.scores) },
    current: current.faceMatch,
    currentFalseMatchRate: passRate(people.scores, current.faceMatch),
    currentGenuinePass: passRate(genuineFace, current.faceMatch),
    // Where different people stay below, at targetFmr. Only ever raises
    // FACE_MATCH: these pairs are live face against live face, while the
    // check is an older, smaller ID photo against a live face, and those
    // scores for different people are not kept.
    differentPeopleBelow: suggestedFace,
    suggested: null,
    suggestedFalseMatchRate: null,
    suggestedGenuinePass: null,
    pairsAboveCurrent: people.pairsAbove(current.faceMatch).length,
  };
  if (suggestedFace !== null) {
    face.suggested = Math.max(suggestedFace, current.faceMatch);
    face.suggestedFalseMatchRate = passRate(people.scores, face.suggested);
    face.suggestedGenuinePass = passRate(genuineFace, face.suggested);
  }

  // Turns and flashes: real people who were approved should nearly all
  // pass, so the suggestion is the 5th percentile of approved checks, never
  // looser than half the current setting.
  const fifth = (name, floor) => {
    const values = valuesOf(approvedAll, name).sort((left, right) => left - right);
    if (values.length === 0) {
      return null;
    }
    return Math.max(floor, Math.floor(quantile(values, 0.05)));
  };
  const suggestions = {
    FACE_MATCH: face.suggested,
    SAME_PERSON: null,
    TURN_YAW_DEGREES: fifth('turnYaw', current.turnYaw / 2),
    TURN_PITCH_DEGREES: fifth('turnPitch', current.turnPitch / 2),
    FLASHES_NEEDED: fifth('flashes', Math.ceil(current.flashes / 2)),
  };
  // The same person's frames: as alike as the least alike approved check's,
  // less a margin, but never below where different people start.
  const frames = valuesOf(approvedAll, 'framesLowest').sort((left, right) => left - right);
  if (frames.length > 0) {
    let samePerson = Math.floor((quantile(frames, 0.02) - 0.05) * 100) / 100;
    const impostorHigh = quantile(people.scores, 0.99);
    if (impostorHigh !== null && samePerson < impostorHigh) {
      samePerson = Math.ceil(impostorHigh * 100) / 100;
    }
    suggestions.SAME_PERSON = samePerson;
  }

  // Why not to trust the suggestions yet: [{ code, count, want }], put
  // into words by printReport and by the page (admin.tuning-warning.*).
  const warnings = [];
  if (approvedAll.length < MIN_APPROVED) {
    warnings.push({ code: 'few_approved', count: approvedAll.length, want: MIN_APPROVED });
  }
  if (people.scores.length < MIN_PAIRS) {
    warnings.push({ code: 'few_pairs', count: people.scores.length, want: MIN_PAIRS });
  }
  if (groups.declined.length < 10) {
    warnings.push({ code: 'few_declined', count: groups.declined.length, want: 10 });
  }
  if (frames.length === 0) {
    warnings.push({ code: 'no_frames', count: 0, want: 1 });
  }
  return {
    counts: { approvedByChecks: groups.auto.length, approvedByAdmin: groups.approved.length, declinedByAdmin: groups.declined.length, templates: templates.length },
    metrics,
    face,
    current,
    suggestions,
    warnings,
    pairsAbove: (threshold) => people.pairsAbove(threshold),
  };
}

const WARNING_TEXT = {
  few_approved: ({ count, want }) => `only ${count} approved checks (want ${want}+): too early to change the turn, flash and same-person settings`,
  few_pairs: ({ count, want }) => `only ${count} pairs of different people (want ${want}+): too early to change FACE_MATCH`,
  few_declined: ({ count }) => `only ${count} checks declined by an admin: the "separation" lines mean little yet`,
  no_frames: () => 'no check has framesLowest yet (kept from now on): SAME_PERSON cannot be suggested',
};

function printSpread(label, values) {
  if (values.n === 0) {
    return `    ${label.padEnd(18)} none`;
  }
  return `    ${label.padEnd(18)} n ${String(values.n).padStart(4)}  min ${values.min}  5% ${values.p5}  median ${values.median}  95% ${values.p95}  max ${values.max}`;
}

export function printReport(report) {
  const lines = [];
  const counts = report.counts;
  lines.push('HelloID calibration', '');
  lines.push(`Checks: ${counts.approvedByChecks} approved by the checks, ${counts.approvedByAdmin} approved by an admin, ${counts.declinedByAdmin} declined by an admin; ${counts.templates} face templates.`, '');
  const labels = {
    faceMatch: 'Face match (ID photo against live face)',
    framesLowest: 'Least alike frame (same person in every frame)',
    turnYaw: 'Weaker sideways turn, degrees',
    turnPitch: 'Weaker up or down turn, degrees',
    flashes: 'Flashes matched',
    faceGoes: 'Goes at the face check',
    real: 'Anti-spoof score (not used yet)',
    live: 'Liveness score (not used yet)',
  };
  for (const [name, metric] of Object.entries(report.metrics)) {
    lines.push(`  ${labels[name]}`);
    lines.push(printSpread('approved (checks)', metric.approvedByChecks));
    lines.push(printSpread('approved (admin)', metric.approvedByAdmin));
    lines.push(printSpread('declined (admin)', metric.declinedByAdmin));
    if (metric.separation) {
      lines.push(`    best cut ${metric.separation.cut}: passes ${Math.round(metric.separation.genuinePass * 100)}% approved, ${Math.round(metric.separation.othersPass * 100)}% declined`);
    }
    lines.push('');
  }
  const face = report.face;
  lines.push('  Different people (approved templates of different accounts)');
  lines.push(`    ${face.differentPeople.pairs} pairs  median ${face.differentPeople.median}  95% ${face.differentPeople.p95}  max ${face.differentPeople.max}`);
  lines.push(`    FACE_MATCH now ${face.current}: different people pass ${face.currentFalseMatchRate}, approved checks pass ${face.currentGenuinePass}`);
  lines.push(`    different people stay below ${face.differentPeopleBelow} (at the target rate); FACE_MATCH is only ever raised to it, never lowered`);
  lines.push(`    suggested ${face.suggested}: different people pass ${face.suggestedFalseMatchRate}, approved checks pass ${face.suggestedGenuinePass}`);
  lines.push(`    ${face.pairsAboveCurrent} pairs of accounts score above FACE_MATCH: lookalikes, or one person verified twice (--list)`, '');
  lines.push('Suggested settings (helloid.js):');
  const settingOf = { FACE_MATCH: 'faceMatch', SAME_PERSON: 'samePerson', TURN_YAW_DEGREES: 'turnYaw', TURN_PITCH_DEGREES: 'turnPitch', FLASHES_NEEDED: 'flashes' };
  for (const [name, value] of Object.entries(report.suggestions)) {
    let suggested = '-';
    if (value !== null) {
      suggested = String(value);
    }
    lines.push(`  ${name.padEnd(20)} now ${String(report.current[settingOf[name]]).padEnd(6)} suggested ${suggested}`);
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Before trusting these:');
    for (const warning of report.warnings) {
      lines.push(`  - ${WARNING_TEXT[warning.code](warning)}`);
    }
  }
  return lines.join('\n');
}

// Every check, decrypted templates of the approved ones, newest first.
export async function load() {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await database()
      .from(TABLES.helloidChecks)
      .select('id, account_id, status, decided_auto, reviewed_by, findings, face_template, submitted_at')
      .order('submitted_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) {
      throw error;
    }
    rows.push(...data);
    if (data.length < pageSize) {
      break;
    }
  }
  const templates = [];
  for (const row of rows) {
    if (row.status !== 'approved' || !row.face_template) {
      continue;
    }
    const plain = decryptSecret(row.face_template);
    if (!plain) {
      continue;
    }
    const opened = openTemplate(plain);
    if (opened) {
      templates.push({ checkId: row.id, accountId: row.account_id, ...opened });
    }
  }
  return { rows, templates };
}

// The report for the face model in use: every check and approved template
// read, those of other face models left out (each model scores on its own
// scale). current: helloid.js CURRENT_THRESHOLDS.
export async function tuningReport(current, { targetFmr = 0.001, maxTemplates = MAX_TEMPLATES } = {}) {
  const { rows, templates } = await load();
  const sameModel = (findings) => {
    let model = 'faceres';
    if (findings && typeof findings.faceModel === 'string') {
      model = findings.faceModel;
    }
    return model === current.model;
  };
  return calibrate(
    rows.filter((row) => sameModel(row.findings)),
    templates.filter((each) => each.model === current.model),
    { current, targetFmr, maxTemplates }
  );
}
