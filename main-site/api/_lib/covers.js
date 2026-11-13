// Event cover pictures, in the public gftvevents_covers Storage bucket
// (migrations/002), always WebP.
//
// The browser converts and compresses the picture to WebP before it is sent
// (js/cover-upload.js). The server then checks what arrived before anything
// reaches Supabase:
//   - it is at most MAX_UPLOAD_BYTES, and really a WebP (the RIFF/WEBP
//     signature, and sharp agrees on the format), not animated;
//   - its dimensions are within MIN_* and MAX_SIDE (re-read from the file,
//     not taken from the browser's word).
// It is then re-encoded once more with sharp at the same size or smaller,
// which strips every byte of metadata (EXIF, GPS) and means a crafted file
// is never stored as sent. The same approach as gftv-linktree's avatars.

import sharp from 'sharp';
import { database, TABLES } from './supabase.js';
import { optionalEnv } from './env.js';
import { randomToken } from './crypto.js';
import { errorDetail } from './http.js';

export const MAX_UPLOAD_BYTES = 1_000_000;
export const MAX_SIDE = 2400;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 180;
// What is stored: the longest side at most this.
const STORE_SIDE = 1600;
// A decompression bomb is a tiny file that claims a huge canvas.
const MAX_INPUT_PIXELS = MAX_SIDE * MAX_SIDE;

// A stored cover's path: "<event id>/<random name>.webp".
const COVER_PATH = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.webp$/;

export function coverUrl(path) {
  if (!path || !COVER_PATH.test(path)) {
    return null;
  }
  const supabaseUrl = optionalEnv('SUPABASE_URL').replace(/\/+$/, '');
  if (!supabaseUrl) {
    return null;
  }
  return `${supabaseUrl}/storage/v1/object/public/${TABLES.coversBucket}/${path}`;
}

// A WebP file starts "RIFF", four bytes of size, then "WEBP".
function isWebp(buffer) {
  if (buffer.length < 16) {
    return false;
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return false;
  }
  return buffer.toString('ascii', 8, 12) === 'WEBP';
}

// { ok: true, buffer, width, height } with the WebP to store, or
// { ok: false, error }. input is base64, with or without a data: prefix.
// Three steps, each stopping at the first problem: decode the text, check
// the picture itself, then re-encode it.
export async function prepareCover(input) {
  const decoded = decodeCover(input);
  if (!decoded.ok) {
    return decoded;
  }
  const checked = await checkCoverPicture(decoded.bytes);
  if (!checked.ok) {
    return checked;
  }
  return reencodeCover(decoded.bytes);
}

// Step 1: the base64 text to bytes. Anything too large, not base64, or
// without the WebP signature is refused before sharp ever reads it.
function decodeCover(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'cover_invalid' };
  }
  const dataPrefix = input.match(/^data:([a-z/+.-]+);base64,/i);
  if (dataPrefix && dataPrefix[1].toLowerCase() !== 'image/webp') {
    return { ok: false, error: 'cover_not_webp' };
  }
  let base64 = input;
  if (dataPrefix) {
    base64 = input.slice(dataPrefix[0].length);
  }
  // Base64 is four characters for every three bytes, plus up to four of
  // padding, so a longer text cannot fit in MAX_UPLOAD_BYTES.
  if (base64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) {
    return { ok: false, error: 'cover_too_large' };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, error: 'cover_invalid' };
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'cover_too_large' };
  }
  if (!isWebp(bytes)) {
    return { ok: false, error: 'cover_not_webp' };
  }
  return { ok: true, bytes };
}

// Step 2: what sharp reads from the file: a WebP, one frame only, and
// within the size limits.
async function checkCoverPicture(bytes) {
  let metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    return { ok: false, error: 'cover_invalid' };
  }
  if (metadata.format !== 'webp') {
    return { ok: false, error: 'cover_not_webp' };
  }
  let frames = 1;
  if (metadata.pages !== null && metadata.pages !== undefined) {
    frames = metadata.pages;
  }
  if (frames > 1) {
    return { ok: false, error: 'cover_animated' };
  }
  const { width = 0, height = 0 } = metadata;
  if (width > MAX_SIDE || height > MAX_SIDE) {
    return { ok: false, error: 'cover_too_big' };
  }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { ok: false, error: 'cover_too_small' };
  }
  return { ok: true };
}

// Step 3: re-encode at the stored size or smaller. This drops every byte of
// metadata, so a crafted file is never stored as sent.
async function reencodeCover(bytes) {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize(STORE_SIDE, STORE_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, buffer: data, width: info.width, height: info.height };
  } catch (cause) {
    console.warn('[helloevents] cover could not be processed:', errorDetail(cause));
    return { ok: false, error: 'cover_invalid' };
  }
}

// Upload under a fresh random name. Returns the path to keep on the event.
export async function storeCover(eventId, buffer) {
  const path = `${eventId}/${randomToken(18)}.webp`;
  const { error } = await database().storage.from(TABLES.coversBucket).upload(path, buffer, {
    contentType: 'image/webp',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) {
    throw new Error(`cover upload: ${error.message}`);
  }
  return path;
}

// Best effort: a file left behind costs a few hundred kilobytes; a thrown
// error here would fail an action that has otherwise succeeded.
export async function deleteCover(path) {
  if (!path || !COVER_PATH.test(path)) {
    return;
  }
  const { error } = await database().storage.from(TABLES.coversBucket).remove([path]);
  if (error) {
    console.warn('[helloevents] cover delete:', path, error.message);
  }
}
