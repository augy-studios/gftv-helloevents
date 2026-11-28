// HelloID (migrations/027): this site's own, free ID check, for one event
// at a time. Everything runs inside this deploy (Vercel); nothing is sent
// to an outside service.
//
// What the person does, on /helloid?slug=... (js/pages/helloid.js):
//   1. With their legal name and date of birth already on their account
//      (locked once saved, migrations/024), they take a photo of their ID:
//      a passport's photo page, or any photo ID.
//   2. A challenge from the server (issueChallenge): turn left, right, up
//      and down, in a random order, then hold still while the screen
//      flashes red, green and blue, in a random order. The page takes
//      frames at set moments and sends them, with the ID photo, in one go.
//
// What the server checks (analyse), with the face models of Human
// (@vladmandic/human, MIT, on TensorFlow.js's WebAssembly backend) and
// Tesseract (tesseract.js, Apache 2.0) for the passport's machine-readable
// zone (MRZ), parsed and checked with mrz (MIT):
//   - one face in each frame, and the same person in all of them;
//   - turns: the head turned the way it was asked, each in turn (left and
//     right opposite ways in yaw, up and down in pitch);
//   - flashes: the face's colour moved with the colour on the screen (a
//     recording, or a photo held up, does not follow a sequence it has not
//     seen);
//   - the live face matches the face on the ID;
//   - the MRZ: found, its check digits right, not expired, the date of birth
//     the account's, and the name close to the account's legal name.
// All of them clear: approved at once. Anything else (an ID without an MRZ,
// a dim room, a near miss): the event's organisers decide, with the photos
// and these findings in front of them. HelloID never declines on its own.
//
// It cannot tell whether the document itself is genuine; no web page can.
// The thresholds below are a first setting, to be tuned on real checks
// with the HelloID tuning report (/manage, helloid-calibration.js).

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { keyedHash, safeEqual, randomToken } from './crypto.js';
import { repairTd3, findZone, blackAndWhite, bottomOfPhoto, FULL_SCORE } from './mrz-read.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(here, '..', '..', 'node_modules');

// The face models HelloID can make its face templates with (Human's
// face description), and the files each needs. FaceRes is Human's own and
// the default. The others come from @vladmandic/human-models (MIT), fetched
// with scripts/fetch-face-models.js, compared on photos of real people with
// scripts/helloid-face-bakeoff.js, and kept in models/face/ once chosen.
// Each model scores on its own scale: one picked with HELLOID_FACE_MODEL
// needs its own HELLOID_FACE_MATCH and HELLOID_SAME_PERSON (from the
// bake-off), or HelloID keeps to FaceRes and says why in the logs.
export const FACE_MODELS = Object.freeze({
  faceres: { human: {}, files: ['faceres'], faceMatch: 0.55, samePerson: 0.45 },
  'faceres-deep': { human: { description: { enabled: true, modelPath: 'faceres-deep.json' } }, files: ['faceres-deep'] },
  mobilefacenet: { human: { mobilefacenet: { enabled: true, modelPath: 'mobilefacenet.json' } }, files: ['faceres', 'mobilefacenet'] },
});

// The model and its two face thresholds, from the environment:
// { model, faceMatch, samePerson, problem }.
export function faceSetup(env = process.env) {
  const fallback = { model: 'faceres', faceMatch: FACE_MODELS.faceres.faceMatch, samePerson: FACE_MODELS.faceres.samePerson, problem: null };
  let name = 'faceres';
  if (typeof env.HELLOID_FACE_MODEL === 'string') {
    name = env.HELLOID_FACE_MODEL.trim();
  }
  if (name === 'faceres' || name === '') {
    return fallback;
  }
  if (!Object.prototype.hasOwnProperty.call(FACE_MODELS, name)) {
    return { ...fallback, problem: `HELLOID_FACE_MODEL "${name}" is not one of ${Object.keys(FACE_MODELS).join(', ')}` };
  }
  const faceMatch = Number(env.HELLOID_FACE_MATCH);
  const samePerson = Number(env.HELLOID_SAME_PERSON);
  const inRange = (value) => [Number.isFinite(value), value > 0, value < 1].every(Boolean);
  if (!inRange(faceMatch) || !inRange(samePerson)) {
    return { ...fallback, problem: `HELLOID_FACE_MODEL "${name}" needs HELLOID_FACE_MATCH and HELLOID_SAME_PERSON between 0 and 1, from scripts/helloid-face-bakeoff.js` };
  }
  return { model: name, faceMatch, samePerson, problem: null };
}

const FACE = faceSetup();
if (FACE.problem) {
  console.error(`[helloevents] helloid: ${FACE.problem}; using faceres`);
}
export const FACE_MODEL = FACE.model;

// Thresholds (first settings).
const TURN_YAW_DEGREES = 15;
const TURN_PITCH_DEGREES = 10;
const FLASHES_NEEDED = 5;
const FACE_MATCH = FACE.faceMatch;
const SAME_PERSON = FACE.samePerson;
const CHALLENGE_SECONDS = 600;

// The settings above, for the HelloID tuning report to report against.
export const CURRENT_THRESHOLDS = Object.freeze({
  model: FACE_MODEL,
  faceMatch: FACE_MATCH,
  samePerson: SAME_PERSON,
  turnYaw: TURN_YAW_DEGREES,
  turnPitch: TURN_PITCH_DEGREES,
  flashes: FLASHES_NEEDED,
});

// For tests: stand-ins for the slow parts, the face models and the OCR
// ({ analyse, readMrz }, either), so a route can be driven without them.
let testStandIns = null;
export function useTestChecks(standIns) {
  testStandIns = standIns;
}

export const TURNS = Object.freeze(['left', 'right', 'up', 'down']);
const FLASH_COLOURS = Object.freeze(['red', 'green', 'blue']);
export const FLASH_COUNT = 6;
export const FRAMES_PER_TURN = 2;

// ---------------------------------------------------------------------------
// The challenge
// ---------------------------------------------------------------------------

function shuffled(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function challengeSignature(eventId, accountId, issued, turns, flashes, nonce) {
  return keyedHash('helloid-challenge', `${eventId}:${accountId}:${issued}:${turns}:${flashes}:${nonce}`).slice(0, 22);
}

// A new challenge for this person and event: the turns and flashes in a
// random order, and a token carrying them, signed, to send back with the
// frames. -> { token, turns, flashes, expiresInSeconds }
export function issueChallenge(eventId, accountId, now = Date.now()) {
  const turns = shuffled(TURNS);
  const flashes = shuffled([...FLASH_COLOURS, ...FLASH_COLOURS]);
  const issued = Math.floor(now / 1000);
  const turnCode = turns.map((turn) => turn[0]).join('');
  const flashCode = flashes.map((colour) => colour[0]).join('');
  const nonce = randomToken(9);
  const signature = challengeSignature(eventId, accountId, issued, turnCode, flashCode, nonce);
  return {
    token: `${issued}.${turnCode}.${flashCode}.${nonce}.${signature}`,
    turns,
    flashes,
    expiresInSeconds: CHALLENGE_SECONDS,
  };
}

// The turns and flashes a token carries, when it is this person's, for
// this event, and recent: { turns, flashes } or null.
export function readChallenge(token, eventId, accountId, now = Date.now()) {
  const match = /^(\d{9,12})\.([lrud]{4})\.([rgb]{6})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{22})$/.exec(String(token));
  if (!match) {
    return null;
  }
  const [, issuedText, turnCode, flashCode, nonce, signature] = match;
  const issued = Number(issuedText);
  if (now / 1000 - issued > CHALLENGE_SECONDS || issued - now / 1000 > 60) {
    return null;
  }
  if (!safeEqual(signature, challengeSignature(eventId, accountId, issued, turnCode, flashCode, nonce))) {
    return null;
  }
  const turns = [...turnCode].map((letter) => TURNS.find((turn) => turn[0] === letter));
  const flashes = [...flashCode].map((letter) => FLASH_COLOURS.find((colour) => colour[0] === letter));
  if (new Set(turns).size !== TURNS.length) {
    return null;
  }
  return { turns, flashes };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

const MAX_PICTURE_BYTES = 2_000_000;
const MAX_FRAME_BYTES = 300_000;

// A picture sent as base64 (JPEG, PNG or WebP, with or without a data:
// prefix), checked: { ok: true, bytes } or { ok: false }.
function decodePicture(input, maxBytes) {
  if (typeof input !== 'string' || input === '') {
    return { ok: false };
  }
  const base64 = input.replace(/^data:image\/(jpeg|png|webp);base64,/i, '');
  if (base64.length > Math.ceil((maxBytes * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false };
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 16) {
    return { ok: false };
  }
  const jpeg = [bytes[0] === 0xff, bytes[1] === 0xd8, bytes[2] === 0xff].every(Boolean);
  const png = bytes.toString('ascii', 1, 4) === 'PNG';
  const webp = [bytes.toString('ascii', 0, 4) === 'RIFF', bytes.toString('ascii', 8, 12) === 'WEBP'].every(Boolean);
  if (![jpeg, png, webp].some(Boolean)) {
    return { ok: false };
  }
  return { ok: true, bytes };
}

// Pixels for the face models: RGB, at most `side` on the longer side.
async function pixels(bytes, side) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 4000 * 4000, failOn: 'error' })
    .rotate()
    .removeAlpha()
    .resize(side, side, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// The pictures a submission carries, checked and decoded: { ok: true,
// idPhoto, neutral, turnFrames: [[a, b] per turn], flashFrames } (bytes) or
// { ok: false, error }.
export function readSubmission(body, document) {
  const idPhoto = decodePicture(body.front, MAX_PICTURE_BYTES);
  const neutral = decodePicture(body.neutral, MAX_FRAME_BYTES);
  if (!idPhoto.ok || !neutral.ok) {
    return { ok: false, error: 'helloid_pictures_invalid' };
  }
  let idBack = null;
  if (document.sides.includes('back')) {
    const back = decodePicture(body.back, MAX_PICTURE_BYTES);
    if (!back.ok) {
      return { ok: false, error: 'helloid_pictures_invalid' };
    }
    idBack = back.bytes;
  }
  if (!Array.isArray(body.turns) || body.turns.length !== TURNS.length || !Array.isArray(body.flashes) || body.flashes.length !== FLASH_COUNT) {
    return { ok: false, error: 'helloid_pictures_invalid' };
  }
  const turnFrames = [];
  for (const pair of body.turns) {
    if (!Array.isArray(pair) || pair.length !== FRAMES_PER_TURN) {
      return { ok: false, error: 'helloid_pictures_invalid' };
    }
    const decoded = pair.map((frame) => decodePicture(frame, MAX_FRAME_BYTES));
    if (decoded.some((frame) => !frame.ok)) {
      return { ok: false, error: 'helloid_pictures_invalid' };
    }
    turnFrames.push(decoded.map((frame) => frame.bytes));
  }
  const flashFrames = [];
  for (const frame of body.flashes) {
    const decoded = decodePicture(frame, MAX_FRAME_BYTES);
    if (!decoded.ok) {
      return { ok: false, error: 'helloid_pictures_invalid' };
    }
    flashFrames.push(decoded.bytes);
  }
  return { ok: true, idPhoto: idPhoto.bytes, idBack, neutral: neutral.bytes, turnFrames, flashFrames };
}

// The front (and back) of an ID sent on its own, for reading its MRZ before
// the challenge: { ok: true, front, back } or { ok: false }.
export function readDocumentPictures(body, document) {
  const front = decodePicture(body.front, MAX_PICTURE_BYTES);
  if (!front.ok) {
    return { ok: false };
  }
  let back = null;
  if (document.sides.includes('back') && body.back !== undefined) {
    const decoded = decodePicture(body.back, MAX_PICTURE_BYTES);
    if (!decoded.ok) {
      return { ok: false };
    }
    back = decoded.bytes;
  }
  return { ok: true, front: front.bytes, back };
}

// The ID photo and the selfie as stored for the organisers: WebP, no
// metadata, at most 1600 and 800 px.
export async function storedPictures(submission) {
  let idPhoto = await sharp(submission.idPhoto, { limitInputPixels: 4000 * 4000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  // A card's back goes under its front, in one picture for the admins.
  if (submission.idBack) {
    const front = await sharp(submission.idPhoto, { limitInputPixels: 4000 * 4000 }).rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
    const back = await sharp(submission.idBack, { limitInputPixels: 4000 * 4000 }).rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
    const width = Math.max(front.info.width, back.info.width);
    idPhoto = await sharp({ create: { width, height: front.info.height + back.info.height + 16, channels: 3, background: '#ffffff' } })
      .composite([{ input: front.data, top: 0, left: 0 }, { input: back.data, top: front.info.height + 16, left: 0 }])
      .webp({ quality: 82 })
      .toBuffer();
  }
  const selfie = await sharp(submission.neutral, { limitInputPixels: 4000 * 4000 }).rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  return { idPhoto, selfie };
}

// ---------------------------------------------------------------------------
// Face models (Human), loaded once per function instance
// ---------------------------------------------------------------------------

// Human loads its models through fetch; this address is answered from
// files on disk, so nothing is fetched from anywhere: models/face/ (a face
// model chosen for this site), then each folder in modelFolders (the
// bake-off's fetched models), then Human's own.
const MODEL_ORIGIN = 'https://helloid-models.invalid/';
const BASE_MODELS = ['blazeface', 'facemesh', 'antispoof', 'liveness'];
const MODEL_NAME = /^[a-z][a-z0-9-]{1,40}\.(json|bin)$/;
const modelFolders = [path.join(here, 'models', 'face')];
let humanReady = null;

// More folders to look for model files in (scripts/helloid-face-bakeoff.js).
export function addModelFolder(folder) {
  if (!modelFolders.includes(folder)) {
    modelFolders.push(folder);
  }
}

async function modelFile(name) {
  for (const folder of [...modelFolders, path.join(modules, '@vladmandic', 'human', 'models')]) {
    try {
      return await readFile(path.join(folder, name));
    } catch {
      continue;
    }
  }
  return null;
}

function serveModelsFromDisk() {
  const passOn = globalThis.fetch;
  if (passOn.helloidModels === true) {
    return;
  }
  const answer = async (url, init) => {
    const text = String(url);
    if (text.startsWith(MODEL_ORIGIN)) {
      const name = text.slice(MODEL_ORIGIN.length);
      const allowed = [...BASE_MODELS, ...Object.values(FACE_MODELS).flatMap((model) => model.files)];
      const known = allowed.some((model) => [`${model}.json`, `${model}.bin`].includes(name));
      let bytes = null;
      if (known && MODEL_NAME.test(name)) {
        bytes = await modelFile(name);
      }
      if (bytes === null) {
        return new Response('not found', { status: 404 });
      }
      return new Response(bytes);
    }
    return passOn(url, init);
  };
  answer.helloidModels = true;
  globalThis.fetch = answer;
}

// A Human set up for HelloID, its face templates made with faceModel.
export async function loadHuman(faceModel = FACE_MODEL) {
  serveModelsFromDisk();
  // The WebAssembly build, by its file: the package's exports leave it out.
  const { Human } = require('../../node_modules/@vladmandic/human/dist/human.node-wasm.js');
  const wasmPath = `${path.join(modules, '@tensorflow', 'tfjs-backend-wasm', 'dist').split(path.sep).join('/')}/`;
  const human = new Human({
    backend: 'wasm',
    wasmPath,
    modelBasePath: MODEL_ORIGIN,
    debug: false,
    cacheSensitivity: 0,
    filter: { enabled: false },
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 3, minConfidence: 0.4, return: false },
      mesh: { enabled: true },
      iris: { enabled: false },
      description: { enabled: true },
      emotion: { enabled: false },
      antispoof: { enabled: true },
      liveness: { enabled: true },
      ...FACE_MODELS[faceModel].human,
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false },
  });
  await human.load();
  await human.warmup();
  return human;
}

function human() {
  if (!humanReady) {
    humanReady = loadHuman().catch((cause) => {
      humanReady = null;
      throw cause;
    });
  }
  return humanReady;
}

const DEGREES = 180 / Math.PI;

// The faces in a picture: { faces: [{ box, yaw, pitch, embedding, real,
// live }], width, height, data }. model: a Human from loadHuman (the
// bake-off's), else HelloID's own.
export async function facesIn(bytes, side, model = null) {
  if (model === null) {
    model = await human();
  }
  const image = await pixels(bytes, side);
  const tensor = model.tf.tensor3d(new Uint8Array(image.data), [image.height, image.width, 3], 'int32');
  let result;
  try {
    result = await model.detect(tensor);
  } finally {
    model.tf.dispose(tensor);
  }
  const faces = result.face.map((face) => {
    let yaw = 0;
    let pitch = 0;
    if (face.rotation && face.rotation.angle) {
      yaw = face.rotation.angle.yaw * DEGREES;
      pitch = face.rotation.angle.pitch * DEGREES;
    }
    return { box: face.box, yaw, pitch, embedding: face.embedding, real: face.real, live: face.live, size: face.box[2] * face.box[3] };
  });
  return { faces, ...image };
}

function similarity(left, right) {
  if (!left || !right || left.length === 0 || left.length !== right.length) {
    return 0;
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
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

// The mean colour of the middle of the face (cheeks, nose, forehead), as
// shares of red, green and blue.
function faceChroma(image, box) {
  const [boxX, boxY, boxWidth, boxHeight] = box;
  const left = Math.max(0, Math.round(boxX + boxWidth * 0.2));
  const right = Math.min(image.width, Math.round(boxX + boxWidth * 0.8));
  const top = Math.max(0, Math.round(boxY + boxHeight * 0.15));
  const bottom = Math.min(image.height, Math.round(boxY + boxHeight * 0.85));
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * image.width + column) * 3;
      red += image.data[at];
      green += image.data[at + 1];
      blue += image.data[at + 2];
    }
  }
  const total = red + green + blue;
  if (total === 0) {
    return { red: 1 / 3, green: 1 / 3, blue: 1 / 3 };
  }
  return { red: red / total, green: green / total, blue: blue / total };
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// The machine-readable zone
// ---------------------------------------------------------------------------

let ocrReady = null;

// Tesseract with the MRZ-trained model (models/README.md): capitals, digits
// and "<" only, read as a block of lines.
async function loadOcr() {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('mrz', 1, {
    langPath: path.join(here, 'models'),
    gzip: true,
    cacheMethod: 'none',
  });
  await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', tessedit_pageseg_mode: '6' });
  return worker;
}

function ocr() {
  if (!ocrReady) {
    ocrReady = loadOcr().catch((cause) => {
      ocrReady = null;
      throw cause;
    });
  }
  return ocrReady;
}

// Letters folded for comparing names: no accents, upper case, A to Z only.
export function foldName(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      let cost = 1;
      if (left[row - 1] === right[column - 1]) {
        cost = 0;
      }
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length];
}

// The name tokens in an MRZ name field ("ERIKSSON<<ANNA<MARIA<<<"), with
// the filler OCR often misreads ("<" as C or K) cleaned up.
function mrzNameTokens(field) {
  let text = String(field).toUpperCase();
  // Filler at the end, however it was misread.
  text = text.replace(/[<CK]*$/, '');
  return text.split(/<+/).filter((token) => token !== '');
}

// Whether the MRZ's name is close to the account's legal name: every token
// of each finds a token of the other within one edit (two for long ones),
// trying a misread filler (C or K inside a token) as a break too.
export function namesMatch(mrzField, legalName) {
  const accountTokens = foldName(legalName).split(' ').filter((token) => token !== '');
  let mrzTokens = mrzNameTokens(mrzField);
  if (accountTokens.length === 0 || mrzTokens.length === 0) {
    return false;
  }
  const close = (left, right) => {
    let allowed = 1;
    if (Math.max(left.length, right.length) >= 8) {
      allowed = 2;
    }
    return editDistance(left, right) <= allowed;
  };
  const covers = (from, to) => from.every((token) => to.some((other) => close(token, other)));
  // A token that matches nothing may be two run together by a misread
  // filler: split it at its Cs and Ks and try the parts.
  mrzTokens = mrzTokens.flatMap((token) => {
    if (accountTokens.some((other) => close(token, other))) {
      return [token];
    }
    const parts = token.split(/[CK]/).filter((part) => part.length > 1);
    if (parts.length > 1) {
      return parts;
    }
    return [token];
  });
  return [covers(accountTokens, mrzTokens), covers(mrzTokens, accountTokens)].every(Boolean);
}

// A YYMMDD date as YYYY-MM-DD: a birth date in the past, an expiry date in
// the next 20 years.
function mrzDate(text, kind, now = new Date()) {
  if (!/^\d{6}$/.test(String(text))) {
    return null;
  }
  const yy = Number(text.slice(0, 2));
  const thisYear = now.getUTCFullYear() % 100;
  let century = 2000;
  if (kind === 'birth' && yy > thisYear) {
    century = 1900;
  }
  if (kind === 'expiry' && yy > thisYear + 20) {
    century = 1900;
  }
  return `${century + yy}-${text.slice(2, 4)}-${text.slice(4, 6)}`;
}

// The lines of a read that could be an MRZ's: long, with filler.
function zoneLines(text) {
  return text.split('\n').map((line) => line.replace(/\s+/g, '')).filter((line) => [line.length >= 28, line.includes('<')].every(Boolean));
}

// One picture's reading, parsed: a passport's (TD3) two lines repaired
// (mrz-read.js repairTd3), or an ID card's three lines of 30 or a travel
// document's two of 36 as read. -> { lines, result, score, cost, ambiguous }
// or null.
function parsedReading(parse, lines) {
  const passport = lines.filter((line) => Math.abs(line.length - 44) <= 3).slice(-2);
  if (passport.length === 2) {
    const repaired = repairTd3(passport);
    try {
      return { ...repaired, result: parse(repaired.lines, { autocorrect: true }) };
    } catch {
      // Not a passport after all: the other formats below.
    }
  }
  for (const [count, length] of [[2, 36], [3, 30]]) {
    const near = lines.filter((line) => Math.abs(line.length - length) <= 2).slice(-count);
    if (near.length !== count) {
      continue;
    }
    const attempt = near.map((line) => line.padEnd(length, '<').slice(0, length));
    try {
      return { lines: attempt, result: parse(attempt, { autocorrect: true }), score: 0, cost: 0, ambiguous: false };
    } catch {
      continue;
    }
  }
  return null;
}

// The MRZ on a side of an ID, read and checked: { found, ...fields } where
// found is false when there is none to read. The zone, found and cropped,
// is read first, then as black and white, then the bottom of the photo
// (mrz-read.js), stopping at a passport read whole with every check digit
// right. A repaired reading counts only when another picture's agrees
// (mrz-read.js says why); otherwise its document number is left unchecked.
export async function readMrz(bytes) {
  if (testStandIns && testStandIns.readMrz) {
    return testStandIns.readMrz(bytes);
  }
  const { parse } = await import('mrz');
  const worker = await ocr();
  const pictures = [];
  const zone = await findZone(bytes).catch(() => null);
  if (zone) {
    pictures.push(() => zone, () => blackAndWhite(zone));
  }
  pictures.push(() => bottomOfPhoto(bytes));
  const readings = [];
  for (const picture of pictures) {
    const { data } = await worker.recognize(await picture());
    const reading = parsedReading(parse, zoneLines(data.text));
    if (reading === null) {
      continue;
    }
    readings.push(reading);
    if (reading.score === FULL_SCORE && reading.cost === 0) {
      break;
    }
  }
  if (readings.length === 0) {
    return { found: false };
  }
  let best = readings[0];
  for (const reading of readings) {
    if (reading.score > best.score || (reading.score === best.score && reading.cost < best.cost)) {
      best = reading;
    }
  }
  let ambiguous = best.ambiguous;
  if (best.cost > 0 && !ambiguous) {
    ambiguous = !readings.some((reading) => [reading !== best, reading.lines[1] === best.lines[1]].every(Boolean));
  }
  const { result, lines } = best;
  const valid = (name) => {
    const detail = result.details.find((each) => each.field === name);
    if (!detail) {
      return false;
    }
    return detail.valid === true;
  };
  let nameField = '';
  if (result.format === 'TD3' || result.format === 'TD2') {
    nameField = lines[0].slice(5);
  } else if (result.format === 'TD1') {
    nameField = lines[2];
  }
  return {
    found: true,
    format: result.format,
    nameField,
    name: [result.fields.firstName, result.fields.lastName].filter((part) => part).join(' '),
    birth: mrzDate(result.fields.birthDate, 'birth'),
    birthChecked: [valid('birthDate'), valid('birthDateCheckDigit')].every(Boolean),
    expiry: mrzDate(result.fields.expirationDate, 'expiry'),
    expiryChecked: [valid('expirationDate'), valid('expirationDateCheckDigit')].every(Boolean),
    // The whole zone valid too (real country codes, every field's
    // characters), and not ambiguous: a misread can pass two check digits
    // by luck.
    documentChecked: [valid('documentNumber'), valid('documentNumberCheckDigit'), result.valid === true, !ambiguous].every(Boolean),
    ambiguous,
    documentNumber: result.fields.documentNumber,
    issuingState: result.fields.issuingState,
  };
}

// ---------------------------------------------------------------------------
// The whole check
// ---------------------------------------------------------------------------

// Checks a submission against the challenge and the account. -> { approve,
// findings } where findings is what the organisers see (each check's
// outcome and numbers), and approve says whether all of them were clear.
// personal: the account's { legalName, dateOfBirth }.
// document: the type picked (helloid-documents.js), whose mrz says which
// side to read; personal: the { legalName, dateOfBirth } it is for.
// -> { approve, findings, template, documentNumber, documentCountry }
export async function analyse(submission, challenge, personal, document, now = new Date()) {
  if (testStandIns && testStandIns.analyse) {
    return testStandIns.analyse(submission, challenge, personal, document);
  }
  const findings = { checks: {}, notes: [], faceModel: FACE_MODEL };
  const fail = (check, note) => {
    findings.checks[check] = false;
    if (note) {
      findings.notes.push(note);
    }
  };

  // The live face first: it is what every other frame is held to.
  const neutral = await facesIn(submission.neutral, 640);
  if (neutral.faces.length !== 1) {
    fail('live', 'neutral_faces');
    return { approve: false, findings, template: null, faceModel: FACE_MODEL, documentNumber: null, documentCountry: null };
  }
  const live = neutral.faces[0];
  findings.real = round(live.real);
  findings.live = round(live.live);

  // Turns: the angle against the face held straight, the larger of each
  // turn's two frames.
  const turnResults = {};
  let samePerson = true;
  // The least alike any frame was to the live face, kept in the findings
  // for the HelloID tuning report (helloid-calibration.js) to set SAME_PERSON from.
  let lowestLikeness = null;
  const likeness = (face) => {
    const score = similarity(face.embedding, live.embedding);
    if (lowestLikeness === null || score < lowestLikeness) {
      lowestLikeness = score;
    }
    return score;
  };
  for (let index = 0; index < challenge.turns.length; index += 1) {
    const turn = challenge.turns[index];
    let best = null;
    for (const frame of submission.turnFrames[index]) {
      const found = await facesIn(frame, 480);
      if (found.faces.length !== 1) {
        continue;
      }
      const face = found.faces[0];
      if (likeness(face) < SAME_PERSON * 0.7) {
        samePerson = false;
      }
      const delta = { yaw: face.yaw - live.yaw, pitch: face.pitch - live.pitch };
      let strength = Math.abs(delta.pitch);
      if (turn === 'left' || turn === 'right') {
        strength = Math.abs(delta.yaw);
      }
      if (best === null || strength > best.strength) {
        best = { ...delta, strength };
      }
    }
    turnResults[turn] = best;
  }
  findings.turns = Object.fromEntries(TURNS.map((turn) => {
    const result = turnResults[turn];
    if (!result) {
      return [turn, null];
    }
    return [turn, { yaw: round(result.yaw, 0), pitch: round(result.pitch, 0) }];
  }));
  const sideways = ['left', 'right'].map((turn) => turnResults[turn]);
  const vertical = ['up', 'down'].map((turn) => turnResults[turn]);
  let turnsPass = [...sideways, ...vertical].every((result) => result !== null);
  if (turnsPass) {
    // Each far enough, mostly on its own axis, and the pair opposite ways
    // (either way round: some cameras mirror the picture).
    const [left, right] = sideways;
    const [up, down] = vertical;
    turnsPass = [
      Math.abs(left.yaw) >= TURN_YAW_DEGREES,
      Math.abs(right.yaw) >= TURN_YAW_DEGREES,
      Math.sign(left.yaw) !== Math.sign(right.yaw),
      Math.abs(left.yaw) > Math.abs(left.pitch),
      Math.abs(right.yaw) > Math.abs(right.pitch),
      Math.abs(up.pitch) >= TURN_PITCH_DEGREES,
      Math.abs(down.pitch) >= TURN_PITCH_DEGREES,
      Math.sign(up.pitch) !== Math.sign(down.pitch),
      Math.abs(up.pitch) > Math.abs(up.yaw) * 0.6,
      Math.abs(down.pitch) > Math.abs(down.yaw) * 0.6,
    ].every(Boolean);
  }
  findings.checks.turns = turnsPass;

  // Flashes: which colour each frame's face moved towards, against the
  // average of all of them.
  const chromas = [];
  for (const frame of submission.flashFrames) {
    const found = await facesIn(frame, 480);
    if (found.faces.length !== 1) {
      chromas.push(null);
      continue;
    }
    if (likeness(found.faces[0]) < SAME_PERSON) {
      samePerson = false;
    }
    chromas.push(faceChroma(found, found.faces[0].box));
  }
  const seen = chromas.filter((chroma) => chroma !== null);
  let flashMatches = 0;
  if (seen.length > 0) {
    const mean = { red: 0, green: 0, blue: 0 };
    for (const chroma of seen) {
      for (const colour of FLASH_COLOURS) {
        mean[colour] += chroma[colour] / seen.length;
      }
    }
    chromas.forEach((chroma, index) => {
      if (chroma === null) {
        return;
      }
      const shifts = FLASH_COLOURS.map((colour) => [colour, chroma[colour] - mean[colour]]);
      shifts.sort((first, second) => second[1] - first[1]);
      if (shifts[0][0] === challenge.flashes[index]) {
        flashMatches += 1;
      }
    });
  }
  findings.flashes = { matched: flashMatches, of: FLASH_COUNT };
  findings.checks.flashes = flashMatches >= FLASHES_NEEDED;
  findings.checks.samePerson = samePerson;
  if (lowestLikeness !== null) {
    findings.framesLowest = round(lowestLikeness);
  }

  // The face on the ID: the largest one on the photo.
  const id = await facesIn(submission.idPhoto, 1280);
  if (id.faces.length === 0) {
    fail('faceMatch', 'id_no_face');
  } else {
    const idFace = [...id.faces].sort((first, second) => second.size - first.size)[0];
    findings.faceMatch = round(similarity(idFace.embedding, live.embedding));
    findings.checks.faceMatch = findings.faceMatch >= FACE_MATCH;
  }

  // The MRZ, held to the name and date of birth it is for.
  let mrz = { found: false };
  let mrzSide = null;
  if (document.mrz === 'front') {
    mrzSide = submission.idPhoto;
  } else if (document.mrz === 'back') {
    mrzSide = submission.idBack;
  }
  if (mrzSide) {
    try {
      mrz = await readMrz(mrzSide);
    } catch (cause) {
      findings.notes.push('mrz_error');
      console.error('[helloevents] helloid mrz:', String(cause));
    }
  }
  if (!mrz.found) {
    let note = 'mrz_not_found';
    if (!mrzSide) {
      note = 'document_without_mrz';
    }
    fail('mrz', note);
  } else {
    findings.mrz = { name: mrz.name, birth: mrz.birth, expiry: mrz.expiry, format: mrz.format };
    if (mrz.ambiguous) {
      findings.notes.push('mrz_ambiguous');
    }
    const today = now.toISOString().slice(0, 10);
    const notExpired = [mrz.expiryChecked, mrz.expiry !== null, mrz.expiry >= today].every(Boolean);
    const birthMatches = [mrz.birthChecked, mrz.birth !== null, mrz.birth === personal.dateOfBirth].every(Boolean);
    const nameMatches = namesMatch(mrz.nameField, personal.legalName);
    findings.mrz.notExpired = notExpired;
    findings.mrz.birthMatches = birthMatches;
    findings.mrz.nameMatches = nameMatches;
    findings.checks.mrz = [notExpired, birthMatches, nameMatches, mrz.documentChecked].every(Boolean);
  }

  const approve = ['turns', 'flashes', 'samePerson', 'faceMatch', 'mrz'].every((check) => findings.checks[check] === true);
  let documentNumber = null;
  let documentCountry = null;
  if (mrz.found && mrz.documentChecked) {
    documentNumber = mrz.documentNumber;
    documentCountry = mrz.issuingState;
  }
  return { approve, findings, template: Array.from(live.embedding), faceModel: FACE_MODEL, documentNumber, documentCountry };
}

// How alike two face templates are, from -1 to 1 (at SAME_FACE or above:
// the same person, most likely).
export function templateSimilarity(left, right) {
  return similarity(left, right);
}

export const SAME_FACE = FACE_MATCH;

// ---------------------------------------------------------------------------
// Device & IP analysis
// ---------------------------------------------------------------------------

const VIRTUAL_CAMERAS = /obs|virtual|manycam|snap camera|xsplit|droidcam|epoccam|iriun|\bcamo\b|mmhmm|vcam|fake|splitcam|youcam/i;

function limitedText(value, length) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).slice(0, length);
}

// The device and connection: what the page says of the device (its camera's
// name, time zone, screen, platform, cores, touch, webdriver), the
// address's country (Vercel's x-vercel-ip-country) and the browser.
// -> { findings, flags, hash }: flags send a check to the admins (a virtual
// camera, an automated browser); hash recognises the device again.
export function analyseDevice(device, request, documentCountry) {
  let given = device;
  if (!given || typeof given !== 'object') {
    given = {};
  }
  const camera = limitedText(given.camera, 120);
  const timeZone = limitedText(given.timeZone, 60);
  const screen = limitedText(given.screen, 30);
  const platform = limitedText(given.platform, 60);
  let cores = Number(given.cores);
  if (!Number.isInteger(cores) || cores < 0 || cores > 512) {
    cores = 0;
  }
  const touch = given.touch === true;
  const agent = limitedText(request.headers['user-agent'], 300);
  const ipCountry = limitedText(request.headers['x-vercel-ip-country'], 2).toUpperCase();
  const flags = [];
  if (camera && VIRTUAL_CAMERAS.test(camera)) {
    flags.push('virtual_camera');
  }
  if (/headless|phantom|selenium|puppeteer|playwright/i.test(agent) || given.webdriver === true) {
    flags.push('automated_browser');
  }
  const notes = [];
  if (ipCountry && documentCountry && ipCountry !== documentCountry) {
    notes.push('ip_country_differs');
  }
  const hash = keyedHash('helloid-device', [agent, screen, timeZone, platform, cores, touch].join('|')).slice(0, 32);
  return {
    findings: { camera, timeZone, screen, platform, cores, touch, ipCountry, flags, notes },
    flags,
    hash,
  };
}
