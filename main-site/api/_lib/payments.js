// Pictures for checkout (migrations/016), in the private gftvevents_payments
// Storage bucket:
//   qr/<event id>/<random>.png               an event's payment QR code
//   proof/<event id>/<account id>/<random>.webp  someone's payment screenshot
//   reg/<event id>/<account id>/<random>.webp    a registration form photo,
//                                                such as a con badge photo
//                                                (migrations/024)
//   entry/<event id>/<random>.png             an organiser's entry QR code
//                                                (migrations/027)
//   helloid/<account id>/<random>.webp        a HelloID check's ID photo
//                                                and selfie, kept only until
//                                                it is decided (migrations/027)
//
// The browser draws the picture onto a canvas and sends it (js/picture-file.js):
// a QR code as PNG, at its own shape (no crop, no fixed aspect ratio), kept
// lossless so it still scans; a screenshot as WebP. As for covers
// (covers.js), the server checks what arrived (size, signature, format,
// one frame, dimensions) before anything reaches Supabase, then re-encodes
// it with sharp, which drops every byte of metadata.
//
// Neither is ever public. QR codes go to signed-in people through
// api/events/payment-qr.js, screenshots to editors only through
// api/manage/payment-proof.js, never cached by a shared cache.

import sharp from 'sharp';
import { database, TABLES } from './supabase.js';
import { randomToken } from './crypto.js';
import { errorDetail } from './http.js';
import { photoNames } from '../../js/registration-fields.js';

export const MAX_QR_BYTES = 2_000_000;
export const MAX_PROOF_BYTES = 1_500_000;
const MAX_SIDE = 4000;
const MIN_SIDE = 64;
// Kept small on purpose: a QR code scans fine at 1200 px, and a receipt
// screenshot reads fine at 1600 px.
const QR_STORE_SIDE = 1200;
const PROOF_STORE_SIDE = 1600;
// A con badge photo prints at a few centimetres across.
const PHOTO_STORE_SIDE = 1200;
const MAX_INPUT_PIXELS = MAX_SIDE * MAX_SIDE;

const QR_PATH = /^qr\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.png$/;
const PROOF_PATH = /^proof\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.webp$/;
const PHOTO_PATH = /^reg\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.webp$/;
const ENTRY_PATH = /^entry\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.png$/;
const HELLOID_PATH = /^helloid\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.webp$/;

const KINDS = {
  qr: { format: 'png', mime: 'image/png', maxBytes: MAX_QR_BYTES, side: QR_STORE_SIDE, error: 'qr' },
  proof: { format: 'webp', mime: 'image/webp', maxBytes: MAX_PROOF_BYTES, side: PROOF_STORE_SIDE, error: 'proof' },
  photo: { format: 'webp', mime: 'image/webp', maxBytes: MAX_PROOF_BYTES, side: PHOTO_STORE_SIDE, error: 'photo' },
};

// A PNG starts with its 8-byte signature; a WebP with "RIFF", four bytes of
// size, then "WEBP".
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hasSignature(bytes, format) {
  if (format === 'png') {
    if (bytes.length <= PNG_SIGNATURE.length) {
      return false;
    }
    return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  if (bytes.length < 16 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    return false;
  }
  return bytes.toString('ascii', 8, 12) === 'WEBP';
}

// The base64 text (with or without a data: prefix) as bytes of the expected
// format: { ok: true, bytes } or { ok: false, error }.
function decode(input, kind) {
  const spec = KINDS[kind];
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  const dataPrefix = input.match(/^data:([a-z/+.-]+);base64,/i);
  if (dataPrefix && dataPrefix[1].toLowerCase() !== spec.mime) {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  let base64 = input;
  if (dataPrefix) {
    base64 = input.slice(dataPrefix[0].length);
  }
  if (base64.length > Math.ceil((spec.maxBytes * 4) / 3) + 4) {
    return { ok: false, error: `${spec.error}_too_large` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > spec.maxBytes) {
    return { ok: false, error: `${spec.error}_too_large` };
  }
  if (!hasSignature(bytes, spec.format)) {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  return { ok: true, bytes };
}

// The picture checked and re-encoded: { ok: true, buffer } or { ok: false,
// error }. kind: 'qr', 'proof' or 'photo'. A QR code stays PNG (lossless) and is
// never enlarged; any shape is fine, as long as neither side is under
// MIN_SIDE or over MAX_SIDE.
export async function preparePicture(input, kind) {
  const spec = KINDS[kind];
  const decoded = decode(input, kind);
  if (!decoded.ok) {
    return decoded;
  }
  let metadata;
  try {
    metadata = await sharp(decoded.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  if (metadata.format !== spec.format) {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  if (metadata.pages !== null && metadata.pages !== undefined && metadata.pages > 1) {
    return { ok: false, error: `${spec.error}_invalid` };
  }
  const { width = 0, height = 0 } = metadata;
  if (width > MAX_SIDE || height > MAX_SIDE || width < MIN_SIDE || height < MIN_SIDE) {
    return { ok: false, error: `${spec.error}_size` };
  }
  try {
    let pipeline = sharp(decoded.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize(spec.side, spec.side, { fit: 'inside', withoutEnlargement: true });
    if (spec.format === 'png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
    } else {
      pipeline = pipeline.webp({ quality: 80, effort: 4 });
    }
    return { ok: true, buffer: await pipeline.toBuffer() };
  } catch (cause) {
    console.warn('[helloevents] payment picture could not be processed:', errorDetail(cause));
    return { ok: false, error: `${spec.error}_invalid` };
  }
}

async function upload(path, buffer, contentType) {
  const { error } = await database().storage.from(TABLES.paymentsBucket).upload(path, buffer, {
    contentType,
    cacheControl: '0',
    upsert: false,
  });
  if (error) {
    throw new Error(`payment picture upload: ${error.message}`);
  }
  return path;
}

export function storeQr(eventId, buffer) {
  return upload(`qr/${eventId}/${randomToken(18)}.png`, buffer, 'image/png');
}

export function storeProof(eventId, accountId, buffer) {
  return upload(`proof/${eventId}/${accountId}/${randomToken(18)}.webp`, buffer, 'image/webp');
}

// An organiser's entry QR code (migrations/027), kept as a lossless PNG.
export function storeEntryCode(eventId, buffer) {
  return upload(`entry/${eventId}/${randomToken(18)}.png`, buffer, 'image/png');
}

// A HelloID check's picture (migrations/027): the ID photo or the selfie,
// already checked and re-encoded by helloid.js.
export function storeHelloidPicture(accountId, buffer) {
  return upload(`helloid/${accountId}/${randomToken(18)}.webp`, buffer, 'image/webp');
}

function isPaymentPath(path) {
  if (typeof path !== 'string') {
    return false;
  }
  if (QR_PATH.test(path) || PHOTO_PATH.test(path)) {
    return true;
  }
  if (ENTRY_PATH.test(path) || HELLOID_PATH.test(path)) {
    return true;
  }
  return PROOF_PATH.test(path);
}

// A registration photo (migrations/024): stored under the event and the
// account, so an answer (the file's name alone) can only ever point at the
// person's own photo for that event. Returns the name.
export async function storeRegistrationPhoto(eventId, accountId, buffer) {
  const name = randomToken(18);
  await upload(registrationPhotoPath(eventId, accountId, name), buffer, 'image/webp');
  return name;
}

export function registrationPhotoPath(eventId, accountId, name) {
  return `reg/${eventId}/${accountId}/${name}.webp`;
}

// Whether a registration photo of this name was stored for this person and
// event (so an answer cannot name a file that is not there).
export async function registrationPhotoExists(eventId, accountId, name) {
  const { data, error } = await database().storage.from(TABLES.paymentsBucket).list(`reg/${eventId}/${accountId}`, { search: name });
  if (error || !Array.isArray(data)) {
    return false;
  }
  return data.some((file) => file.name === `${name}.webp`);
}

// The registration photo files of an event's attendees (all of them, or one
// account's), for deleting along with what they belong to.
export async function registrationPhotoPaths(eventId, accountId = null) {
  let request = database().from(TABLES.attendees).select('event_id, user_id, registration');
  if (eventId) {
    request = request.eq('event_id', eventId);
  }
  if (accountId) {
    request = request.eq('user_id', accountId);
  }
  const { data, error } = await request;
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((row) => photoNames(row.registration).map((name) => registrationPhotoPath(row.event_id, row.user_id, name)));
}

// Best effort, as for covers: a file left behind costs little; a thrown
// error would fail an action that has otherwise succeeded. paths: any number
// of stored paths, nulls skipped.
export async function deletePaymentFiles(paths) {
  const known = paths.filter(isPaymentPath);
  if (known.length === 0) {
    return;
  }
  const { error } = await database().storage.from(TABLES.paymentsBucket).remove(known);
  if (error) {
    console.warn('[helloevents] payment picture delete:', error.message);
  }
}

// A stored picture's bytes and type, or null when it is gone.
export async function readPaymentFile(path) {
  if (!isPaymentPath(path)) {
    return null;
  }
  const { data, error } = await database().storage.from(TABLES.paymentsBucket).download(path);
  if (error || !data) {
    return null;
  }
  let type = 'image/webp';
  if (path.endsWith('.png')) {
    type = 'image/png';
  }
  return { bytes: Buffer.from(await data.arrayBuffer()), type };
}

// The name part of a stored QR code's path, which changes with every
// upload, for the address the pages load it from ('' when there is none).
export function qrVersion(path) {
  if (!path || !QR_PATH.test(path)) {
    return '';
  }
  return path.slice(path.lastIndexOf('/') + 1, -'.png'.length);
}

// Where the checkout page loads an event's QR code from, or null.
export function qrUrl(row) {
  const version = qrVersion(row.payment_qr_path);
  if (!version || !row.slug) {
    return null;
  }
  return `/api/events/payment-qr?slug=${encodeURIComponent(row.slug)}&v=${encodeURIComponent(version)}`;
}

// The payment pictures stored for an event's attendees (all of them, or one
// account's), for deleting along with what they belong to.
export async function proofPaths(eventId, accountId = null) {
  let request = database().from(TABLES.attendees).select('payment_proof_path').not('payment_proof_path', 'is', null);
  if (eventId) {
    request = request.eq('event_id', eventId);
  }
  if (accountId) {
    request = request.eq('user_id', accountId);
  }
  const { data, error } = await request;
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((row) => row.payment_proof_path);
}
