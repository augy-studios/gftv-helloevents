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
import { siteUrl } from './env.js';
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

// Where the pages load an event's cover from: this site's own
// api/events/cover.js, never the Storage bucket, so the bucket's address
// never reaches a browser. The cover's own name is in it (v), so a new
// upload gets a new address and an old one is never shown from a cache.
// null for an event with no cover. row: { slug, cover_image_path }.
export function coverUrl(row) {
  const version = coverVersion(row.cover_image_path);
  if (!version || !row.slug) {
    return null;
  }
  return `/api/events/cover?slug=${encodeURIComponent(row.slug)}&v=${encodeURIComponent(version)}`;
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

// ---------------------------------------------------------------------------
// Link previews (api/events/page.js, api/events/embed-image.js). The cover is
// stored as WebP, which not every app that unfurls links reads, so previews
// get it as a JPEG, the whole picture with no cropping.
// ---------------------------------------------------------------------------

// The longest side of a preview picture: what Discord, Telegram and X show
// at their largest.
const EMBED_SIDE = 1200;

// A stored cover's own name ("<random>" of "<event id>/<random>.webp"), which
// changes with every upload. Preview picture addresses carry it, so an app
// that cached the old picture fetches the new one. '' when there is none.
export function coverVersion(path) {
  if (!path || !COVER_PATH.test(path)) {
    return '';
  }
  return path.slice(path.indexOf('/') + 1, -'.webp'.length);
}

// The cover as a JPEG (api/events/embed-image.js), for link previews and the
// picture in a Telegram event notice, or null for an event with no cover.
// Covers are stored as WebP, which neither every link unfurler nor Telegram
// takes as a photo.
export function embedImageUrl(row) {
  const version = coverVersion(row.cover_image_path);
  if (!version) {
    return null;
  }
  return `${siteUrl()}/api/events/embed-image?slug=${encodeURIComponent(row.slug)}&v=${encodeURIComponent(version)}`;
}

// The stored cover's bytes, or null when it is gone from the bucket.
export async function readCover(path) {
  if (!path || !COVER_PATH.test(path)) {
    return null;
  }
  const { data, error } = await database().storage.from(TABLES.coversBucket).download(path);
  if (error || !data) {
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

// The cover as a preview picture: a JPEG, its longest side at most
// EMBED_SIDE, on white where it had transparency.
export async function embedPicture(bytes) {
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
    .resize(EMBED_SIDE, EMBED_SIDE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}
