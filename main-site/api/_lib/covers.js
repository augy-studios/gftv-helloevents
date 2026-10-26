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
import { db, T } from './supabase.js';
import { optionalEnv } from './env.js';
import { randomToken } from './crypto.js';

export const MAX_UPLOAD_BYTES = 1_000_000;
export const MAX_SIDE = 2400;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 180;
// What is stored: the longest side at most this.
const STORE_SIDE = 1600;
// A decompression bomb is a tiny file that claims a huge canvas.
const MAX_INPUT_PIXELS = MAX_SIDE * MAX_SIDE;

const PATH = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.webp$/;

export function coverUrl(path) {
  if (!path || !PATH.test(path)) return null;
  const base = optionalEnv('SUPABASE_URL').replace(/\/+$/, '');
  return base ? `${base}/storage/v1/object/public/${T.coversBucket}/${path}` : null;
}

function isWebp(buffer) {
  return buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

// { ok: true, buffer, width, height } with the WebP to store, or
// { ok: false, error }. input is base64, with or without a data: prefix.
export async function prepareCover(input) {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, error: 'cover_invalid' };
  const prefix = input.match(/^data:([a-z/+.-]+);base64,/i);
  if (prefix && prefix[1].toLowerCase() !== 'image/webp') return { ok: false, error: 'cover_not_webp' };
  const base64 = prefix ? input.slice(prefix[0].length) : input;
  if (base64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) return { ok: false, error: 'cover_too_large' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { ok: false, error: 'cover_invalid' };
  const raw = Buffer.from(base64, 'base64');
  if (raw.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'cover_too_large' };
  if (!isWebp(raw)) return { ok: false, error: 'cover_not_webp' };

  let meta;
  try {
    meta = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    return { ok: false, error: 'cover_invalid' };
  }
  if (meta.format !== 'webp') return { ok: false, error: 'cover_not_webp' };
  if ((meta.pages ?? 1) > 1) return { ok: false, error: 'cover_animated' };
  const { width = 0, height = 0 } = meta;
  if (width > MAX_SIDE || height > MAX_SIDE) return { ok: false, error: 'cover_too_big' };
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return { ok: false, error: 'cover_too_small' };

  try {
    const { data, info } = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize(STORE_SIDE, STORE_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, buffer: data, width: info.width, height: info.height };
  } catch (cause) {
    console.warn('[helloevents] cover could not be processed:', cause?.message ?? cause);
    return { ok: false, error: 'cover_invalid' };
  }
}

// Upload under a fresh random name. Returns the path to keep on the event.
export async function storeCover(eventId, buffer) {
  const path = `${eventId}/${randomToken(18)}.webp`;
  const { error } = await db().storage.from(T.coversBucket).upload(path, buffer, {
    contentType: 'image/webp',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(`cover upload: ${error.message}`);
  return path;
}

// Best effort: a file left behind costs a few hundred kilobytes; a thrown
// error here would fail an action that has otherwise succeeded.
export async function deleteCover(path) {
  if (!path || !PATH.test(path)) return;
  const { error } = await db().storage.from(T.coversBucket).remove([path]);
  if (error) console.warn('[helloevents] cover delete:', path, error.message);
}
