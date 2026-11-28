#!/usr/bin/env node
// node scripts/fetch-face-models.js [--into folder] [model ...]
//
// Downloads the face models HelloID can use besides FaceRes (helloid.js
// FACE_MODELS) from @vladmandic/human-models 3.0.4 (MIT) on unpkg, each
// file checked against the SHA-256 published for it below, into
// .face-models/ (not committed), for scripts/helloid-face-bakeoff.js.
//
// The package itself is not installed: it lists Google Cloud Storage and
// ESLint 8 among its dependencies, which a site has no use for.
//
// Once the bake-off picks a model, put its files where the site serves
// them from, and commit them:
//   node scripts/fetch-face-models.js --into api/_lib/models/face faceres-deep
// then set HELLOID_FACE_MODEL, HELLOID_FACE_MATCH and HELLOID_SAME_PERSON in
// Vercel (README, HelloID).

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://unpkg.com/@vladmandic/human-models@3.0.4/models/';

// Each file's size and SHA-256 (base64), as unpkg publishes them.
export const FILES = {
  'faceres-deep': {
    'faceres-deep.json': [63195, 'qY2Nh9Uzr+tgZIItM8gNRcXqykpDbO8RycIIT/8MDf4='],
    'faceres-deep.bin': [13957620, 'sOosxIBYkaDyLcV7BrV4BrlngxMFxAgYQA/aQK7DQfQ='],
  },
  mobilefacenet: {
    'mobilefacenet.json': [127533, 'v78nZiyhCA39GwqISqFmwTXBt3RrVzhey0QmiCi+uCo='],
    'mobilefacenet.bin': [5171976, 'xg45JHjfCi/XVvmiMMmTWgTRNunTvxLpmoUNSAKAYIk='],
  },
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('base64');
}

// Whether the file is already there, whole.
async function present(file, [size, sha]) {
  try {
    const bytes = await readFile(file);
    return [bytes.length === size, digest(bytes) === sha].every(Boolean);
  } catch {
    return false;
  }
}

async function fetchFile(name, expected, folder) {
  const file = path.join(folder, name);
  if (await present(file, expected)) {
    console.log(`  ${name}: already here`);
    return;
  }
  const response = await fetch(SOURCE + name);
  if (!response.ok) {
    throw new Error(`${name}: ${response.status} from ${SOURCE}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expected[0] || digest(bytes) !== expected[1]) {
    throw new Error(`${name}: not the published file (size or SHA-256 differs); nothing written`);
  }
  await writeFile(file, bytes);
  console.log(`  ${name}: ${Math.round(bytes.length / 1024)} KB`);
}

async function main() {
  const args = process.argv.slice(2);
  let folder = path.join(root, '.face-models');
  const into = args.indexOf('--into');
  const names = [];
  for (let index = 0; index < args.length; index += 1) {
    if (index === into) {
      folder = path.resolve(root, args[index + 1]);
      index += 1;
    } else {
      names.push(args[index]);
    }
  }
  if (names.length === 0) {
    names.push(...Object.keys(FILES));
  }
  await mkdir(folder, { recursive: true });
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(FILES, name)) {
      throw new Error(`no model "${name}": one of ${Object.keys(FILES).join(', ')} (faceres comes with Human)`);
    }
    let where = path.relative(root, folder);
    if (where === '') {
      where = '.';
    }
    console.log(`${name} into ${where}`);
    for (const [file, expected] of Object.entries(FILES[name])) {
      await fetchFile(file, expected, folder);
    }
  }
}

// Run as a command (not imported).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((cause) => {
    console.error(String(cause.message));
    process.exit(1);
  });
}
