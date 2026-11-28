#!/usr/bin/env node
// node scripts/helloid-face-bakeoff.js <folder> [--models faceres,faceres-deep,mobilefacenet] [--target-fmr 0.001]
//
// Which face model HelloID should make its face templates with, measured
// on photos of real people, and the thresholds to use with it.
//
// The photos: one folder per person, each with a photo of their ID
// (a file whose name starts with "id") and one or more selfies:
//
//   faces/
//     person-01/  id.jpg  selfie-1.jpg  selfie-2.jpg
//     person-02/  id-passport.jpg  selfie.jpg
//     ...
//
// Only with each person's consent, for this purpose; kept on your own
// computer, outside this repository (.gitignore leaves out folders named
// helloid-bakeoff*), and deleted when done. Nothing is uploaded: the models
// run here, and the report has counts and scores, never a file or folder
// name. At least 20 people make the numbers worth something; 100 or more is
// better, of the ages, skin tones and IDs HelloID will see.
//
// For each model (helloid.js FACE_MODELS; fetch the others first with
// scripts/fetch-face-models.js):
//   - same person: each ID photo against each of that person's selfies,
//     as HelloID's face match does, and selfie against selfie (the frames
//     of one check);
//   - different people: each ID photo against every other person's
//     selfies;
//   - the equal error rate (where wrongly refusing and wrongly accepting
//     are as likely: lower is better), and the threshold at which at most
//     --target-fmr of different people pass, with how many of the same
//     person pass there.
// Then the model to use and the HELLOID_* settings that go with it.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spread, faceThreshold, quantile } from '../api/_lib/helloid-calibration.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_PEOPLE = 20;
const PICTURE = /\.(jpe?g|png|webp)$/i;

function cosine(left, right) {
  if (!left || !right || left.length === 0 || left.length !== right.length) {
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

// Where the share of same-person scores below a threshold meets the share
// of different-people scores at or above it: { rate, threshold }.
export function equalErrorRate(same, different) {
  if (same.length === 0 || different.length === 0) {
    return null;
  }
  const candidates = [...new Set([...same, ...different])].sort((left, right) => left - right);
  let best = null;
  for (const threshold of candidates) {
    const refused = same.filter((score) => score < threshold).length / same.length;
    const accepted = different.filter((score) => score >= threshold).length / different.length;
    const gap = Math.abs(refused - accepted);
    if (best === null || gap < best.gap) {
      best = { gap, rate: (refused + accepted) / 2, threshold };
    }
  }
  return { rate: Math.round(best.rate * 1000) / 1000, threshold: Math.round(best.threshold * 100) / 100 };
}

function share(values, predicate) {
  if (values.length === 0) {
    return null;
  }
  return Math.round((values.filter(predicate).length / values.length) * 1000) / 1000;
}

// One model's scores, from each person's templates: people = [{ ids:
// [template], lives: [template] }] (a photo with no face found left out).
export function scoreModel(people, targetFmr) {
  const same = [];
  const frames = [];
  const different = [];
  people.forEach((person, index) => {
    for (const id of person.ids) {
      for (const live of person.lives) {
        same.push(cosine(id, live));
      }
      people.forEach((other, otherIndex) => {
        if (otherIndex === index) {
          return;
        }
        for (const live of other.lives) {
          different.push(cosine(id, live));
        }
      });
    }
    for (let first = 0; first < person.lives.length; first += 1) {
      for (let second = first + 1; second < person.lives.length; second += 1) {
        frames.push(cosine(person.lives[first], person.lives[second]));
      }
    }
  });
  const clean = (list) => list.filter((value) => value !== null).sort((left, right) => left - right);
  const samePerson = clean(same);
  const differentPeople = clean(different);
  const sameFrames = clean(frames);
  const faceMatch = faceThreshold(differentPeople, targetFmr);
  let samePersonSetting = null;
  if (sameFrames.length > 0) {
    samePersonSetting = Math.floor((quantile(sameFrames, 0.02) - 0.05) * 100) / 100;
    const differentHigh = quantile(differentPeople, 0.99);
    if (differentHigh !== null && samePersonSetting < differentHigh) {
      samePersonSetting = Math.ceil(differentHigh * 100) / 100;
    }
  }
  let samePass = null;
  let differentPass = null;
  if (faceMatch !== null) {
    samePass = share(samePerson, (score) => score >= faceMatch);
    differentPass = share(differentPeople, (score) => score >= faceMatch);
  }
  return {
    samePerson: spread(samePerson),
    differentPeople: spread(differentPeople),
    sameFrames: spread(sameFrames),
    equalError: equalErrorRate(samePerson, differentPeople),
    faceMatch,
    samePass,
    differentPass,
    samePersonSetting,
  };
}

// The whole bake-off: people = [{ images: [{ kind: 'id' | 'live', bytes }] }],
// templateOf(model, bytes, kind) -> a template or null (no face).
export async function bakeoff(people, models, templateOf, { targetFmr = 0.001 } = {}) {
  const results = {};
  for (const model of models) {
    const started = Date.now();
    let images = 0;
    let missed = 0;
    const templates = [];
    for (const person of people) {
      const each = { ids: [], lives: [] };
      for (const image of person.images) {
        images += 1;
        const template = await templateOf(model, image.bytes, image.kind);
        if (!template) {
          missed += 1;
          continue;
        }
        if (image.kind === 'id') {
          each.ids.push(template);
        } else {
          each.lives.push(template);
        }
      }
      templates.push(each);
    }
    results[model] = { images, noFace: missed, msEach: Math.round((Date.now() - started) / Math.max(1, images)), ...scoreModel(templates, targetFmr) };
  }
  // The best: the lowest equal error rate; among close ones, the one that
  // lets more of the same person through at the target, then the one with
  // the wider gap between the same person's lowest scores and different
  // people's highest.
  const gap = (result) => result.samePerson.p5 - result.differentPeople.max;
  const better = (result, than) => {
    const difference = result.equalError.rate - than.equalError.rate;
    if (Math.abs(difference) > 0.005) {
      return difference < 0;
    }
    if (result.samePass !== than.samePass) {
      return result.samePass > than.samePass;
    }
    return gap(result) > gap(than);
  };
  let best = null;
  for (const [model, result] of Object.entries(results)) {
    if (!result.equalError) {
      continue;
    }
    if (best === null || better(result, results[best])) {
      best = model;
    }
  }
  const warnings = [];
  if (people.length < MIN_PEOPLE) {
    warnings.push(`only ${people.length} people (want ${MIN_PEOPLE}+, better 100+): treat the result as a hint`);
  }
  for (const [model, result] of Object.entries(results)) {
    if (result.images > 0 && result.noFace / result.images > 0.1) {
      warnings.push(`${model} found no face on ${result.noFace} of ${result.images} photos: check those photos (sharp, face in view) before comparing`);
    }
  }
  if (people.some((person) => !person.images.some((image) => image.kind === 'id'))) {
    warnings.push('some people have no ID photo (a file named id...): they only count as different people');
  }
  return { people: people.length, targetFmr, results, best, warnings };
}

export function printBakeoff(report) {
  const lines = [`HelloID face model bake-off: ${report.people} people, at most ${report.targetFmr} of different people let through`, ''];
  for (const [model, result] of Object.entries(report.results)) {
    lines.push(`  ${model}`);
    lines.push(`    ${result.images} photos, no face found on ${result.noFace}, ${result.msEach} ms each`);
    lines.push(`    same person (ID against selfie)   n ${result.samePerson.n}  min ${result.samePerson.min}  5% ${result.samePerson.p5}  median ${result.samePerson.median}`);
    lines.push(`    different people                  n ${result.differentPeople.n}  median ${result.differentPeople.median}  95% ${result.differentPeople.p95}  max ${result.differentPeople.max}`);
    lines.push(`    same person (selfie against selfie) n ${result.sameFrames.n}  min ${result.sameFrames.min}  5% ${result.sameFrames.p5}`);
    if (result.equalError) {
      lines.push(`    equal error rate ${result.equalError.rate} at ${result.equalError.threshold}`);
    }
    lines.push(`    face match threshold ${result.faceMatch}: same person passes ${result.samePass}, different people ${result.differentPass}`);
    lines.push('');
  }
  if (report.best) {
    const best = report.results[report.best];
    lines.push(`Best: ${report.best}. In Vercel:`);
    if (report.best !== 'faceres') {
      lines.push(`  HELLOID_FACE_MODEL=${report.best}`);
    }
    lines.push(`  HELLOID_FACE_MATCH=${best.faceMatch}`);
    if (best.samePersonSetting !== null) {
      lines.push(`  HELLOID_SAME_PERSON=${best.samePersonSetting}`);
    } else {
      lines.push('  HELLOID_SAME_PERSON: needs two selfies per person to measure');
    }
    if (report.best !== 'faceres') {
      lines.push(`and keep its files with the site: node scripts/fetch-face-models.js --into api/_lib/models/face ${report.best}`);
    } else {
      lines.push('(faceres reads HELLOID_FACE_MATCH and HELLOID_SAME_PERSON only with HELLOID_FACE_MODEL set; to change its thresholds, edit FACE_MODELS in helloid.js)');
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Before trusting this:');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines.join('\n');
}

// Each person's photos from the folder: [{ images: [{ kind, bytes }] }].
export async function readPeople(folder) {
  const people = [];
  for (const entry of (await readdir(folder)).sort()) {
    const personFolder = path.join(folder, entry);
    if (!(await stat(personFolder)).isDirectory()) {
      continue;
    }
    const images = [];
    for (const file of (await readdir(personFolder)).sort()) {
      if (!PICTURE.test(file)) {
        continue;
      }
      let kind = 'live';
      if (/^id/i.test(file)) {
        kind = 'id';
      }
      images.push({ kind, bytes: await readFile(path.join(personFolder, file)) });
    }
    if (images.length > 0) {
      people.push({ images });
    }
  }
  return people;
}

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((arg, index) => [!arg.startsWith('--'), !['--models', '--target-fmr'].includes(args[index - 1])].every(Boolean));
  if (!folder) {
    console.log('usage: node scripts/helloid-face-bakeoff.js <folder> [--models faceres,faceres-deep,mobilefacenet] [--target-fmr 0.001]');
    process.exit(1);
  }
  // helloid.js needs a key to load; the bake-off encrypts nothing.
  if (!process.env.TOTP_ENCRYPTION_KEY) {
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  }
  const helloid = await import('../api/_lib/helloid.js');
  helloid.addModelFolder(path.join(root, '.face-models'));
  let models = Object.keys(helloid.FACE_MODELS);
  const modelsAt = args.indexOf('--models');
  if (modelsAt >= 0) {
    models = args[modelsAt + 1].split(',');
  }
  let targetFmr = 0.001;
  const targetAt = args.indexOf('--target-fmr');
  if (targetAt >= 0) {
    targetFmr = Number(args[targetAt + 1]);
  }
  const people = await readPeople(path.resolve(folder));
  const humans = {};
  // HelloID's own sizes: an ID photo at 1280, a live frame at 640; the
  // largest face on each.
  const templateOf = async (model, bytes, kind) => {
    if (!humans[model]) {
      humans[model] = await helloid.loadHuman(model);
    }
    let side = 640;
    if (kind === 'id') {
      side = 1280;
    }
    const found = await helloid.facesIn(bytes, side, humans[model]);
    if (found.faces.length === 0) {
      return null;
    }
    const largest = [...found.faces].sort((first, second) => second.size - first.size)[0];
    return Array.from(largest.embedding);
  };
  console.log(printBakeoff(await bakeoff(people, models, templateOf, { targetFmr })));
}

// Run as a command (not imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), (cause) => {
    console.error(cause);
    process.exit(1);
  });
}
