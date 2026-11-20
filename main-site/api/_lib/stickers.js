// Telegram sticker packs an editor adds to their account (migrations/020),
// for putting stickers in event descriptions.
//
// A pack is added from its link (t.me/addstickers/<name>): the Bot API's
// getStickerSet lists it, and each sticker is copied into the private
// gftvevents_stickers bucket, under the account's id:
//   - a still sticker as the WebP Telegram keeps it in (checked to be one
//     still WebP of at most 1024 pixels a side, then stored as it came);
//   - a video sticker as its WebM (checked to start like one), with a still
//     picture for browsers that cannot play it with its transparency
//     (Safari): Telegram's own small preview at first, which the editor's
//     browser then replaces with the video's full-size first frame
//     (setStill);
//   - an animated (Lottie) sticker is skipped.
// Pages get stickers only from api/stickers/image.js, never from Storage.

import sharp from 'sharp';
import { database, TABLES } from './supabase.js';
import { randomToken } from './crypto.js';
import { botResult, botFile } from './telegram.js';
import { errorDetail } from './http.js';

export const PACK_LIMIT = 30;
export const STICKERS_PER_PACK = 200;
const MAX_STICKER_BYTES = 1_000_000;
const MAX_STICKER_SIDE = 1024;
const DOWNLOADS_AT_ONCE = 6;

// A stored sticker file: "<account id>/<random>.webp" or ".webm".
const STICKER_PATH = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,64}\.(webp|webm)$/;
const PACK_NAME = /^[A-Za-z0-9_]{1,64}$/;
const COLUMNS = 'id, pack_id, account_id, path, still_path, still_from_frame, format, width, height, emoji, position';

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

// A pack's name from what was typed: a t.me/addstickers link (with or
// without https://, or telegram.me), a tg://addstickers?set= link, or the
// name alone. '' when it is none of those.
export function packNameFrom(typed) {
  const text = String(typed).trim();
  let name = text;
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/addstickers\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(text);
  const deepLink = /^tg:\/\/addstickers\?set=([^&#\s]+)/i.exec(text);
  if (link) {
    name = link[1];
  } else if (deepLink) {
    name = deepLink[1];
  }
  if (!PACK_NAME.test(name)) {
    return '';
  }
  return name;
}

// The random name of a stored file ("<random>" of "<account>/<random>.webp").
function fileName(path) {
  if (!path || !STICKER_PATH.test(path)) {
    return '';
  }
  return path.slice(path.indexOf('/') + 1, path.lastIndexOf('.'));
}

// Where a page loads a sticker file from: which is 'main' (the WebP or
// WebM) or 'still' (a video sticker's still picture). '' when there is none.
export function stickerUrl(sticker, which) {
  let path = sticker.path;
  if (which === 'still') {
    path = sticker.still_path;
  }
  const name = fileName(path);
  if (!name) {
    return '';
  }
  return `/api/stickers/image?id=${encodeURIComponent(sticker.id)}&v=${encodeURIComponent(name)}`;
}

// The stored file a sticker address names (its main file or its still), or
// null when v is neither.
export function stickerFileFor(sticker, version) {
  if (version && fileName(sticker.path) === version) {
    return sticker.path;
  }
  if (version && fileName(sticker.still_path) === version) {
    return sticker.still_path;
  }
  return null;
}

// One sticker row by id, or null.
export async function stickerById(id) {
  const { data, error } = await database().from(TABLES.stickers).select(COLUMNS).eq('id', id).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The sticker rows with these ids, by id.
export async function stickersByIds(ids) {
  const found = new Map();
  if (ids.length === 0) {
    return found;
  }
  const { data, error } = await database().from(TABLES.stickers).select(COLUMNS).in('id', ids);
  if (error) {
    throw error;
  }
  if (Array.isArray(data)) {
    for (const row of data) {
      found.set(row.id, row);
    }
  }
  return found;
}

// The stored file's bytes, or null when it is gone.
export async function readStickerFile(path) {
  if (!path || !STICKER_PATH.test(path)) {
    return null;
  }
  const { data, error } = await database().storage.from(TABLES.stickersBucket).download(path);
  if (error || !data) {
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

async function storeFile(accountId, buffer, extension) {
  const path = `${accountId}/${randomToken(18)}.${extension}`;
  let contentType = 'image/webp';
  if (extension === 'webm') {
    contentType = 'video/webm';
  }
  const { error } = await database().storage.from(TABLES.stickersBucket).upload(path, buffer, {
    contentType,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) {
    throw new Error(`sticker upload: ${error.message}`);
  }
  return path;
}

// Best effort, as for covers.
async function deleteFiles(paths) {
  const valid = paths.filter((path) => STICKER_PATH.test(String(path)));
  if (valid.length === 0) {
    return;
  }
  const { error } = await database().storage.from(TABLES.stickersBucket).remove(valid);
  if (error) {
    console.warn('[helloevents] sticker delete:', error.message);
  }
}

// Whether bytes are one still WebP within the size limits: { width, height }
// or null.
async function stillWebp(bytes) {
  if (bytes.length < 16 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_STICKER_SIDE * MAX_STICKER_SIDE * 4, failOn: 'error' }).metadata();
    let frames = 1;
    if (Number.isInteger(metadata.pages)) {
      frames = metadata.pages;
    }
    if (metadata.format !== 'webp' || frames > 1) {
      return null;
    }
    if (!metadata.width || !metadata.height || metadata.width > MAX_STICKER_SIDE || metadata.height > MAX_STICKER_SIDE) {
      return null;
    }
    return { width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}

// A WebM file starts with the EBML header 1A 45 DF A3, and names its type
// "webm".
function isWebm(bytes) {
  if (bytes.length < 32 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    return false;
  }
  return bytes.subarray(0, 64).includes(Buffer.from('webm'));
}

// Any small picture (Telegram's preview, WebP or JPEG) as a still WebP,
// keeping its transparency, or null.
async function previewToWebp(bytes) {
  try {
    return await sharp(bytes, { limitInputPixels: MAX_STICKER_SIDE * MAX_STICKER_SIDE * 4, failOn: 'error' })
      .resize(MAX_STICKER_SIDE, MAX_STICKER_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
  } catch {
    return null;
  }
}

async function downloadFile(fileId, maxBytes) {
  const file = await botResult('getFile', { file_id: fileId });
  if (!file || !file.file_path) {
    return null;
  }
  return botFile(file.file_path, maxBytes);
}

// A sticker's side as Telegram gives it, within MAX_STICKER_SIDE (512 when
// it gives none).
function sideOf(value) {
  const side = Number(value);
  if (!Number.isInteger(side) || side <= 0) {
    return 512;
  }
  return Math.min(MAX_STICKER_SIDE, side);
}

// Copies one sticker into the bucket: the row to insert (without its pack),
// or null for one that is skipped or cannot be copied.
async function copySticker(accountId, sticker, position) {
  if (sticker.is_animated === true) {
    return null;
  }
  const bytes = await downloadFile(sticker.file_id, MAX_STICKER_BYTES);
  if (!bytes) {
    return null;
  }
  let emoji = null;
  if (typeof sticker.emoji === 'string') {
    emoji = sticker.emoji.slice(0, 16);
  }
  if (sticker.is_video === true) {
    if (!isWebm(bytes)) {
      return null;
    }
    let stillPath = null;
    if (sticker.thumbnail && sticker.thumbnail.file_id) {
      const preview = await downloadFile(sticker.thumbnail.file_id, MAX_STICKER_BYTES);
      if (preview) {
        const still = await previewToWebp(preview);
        if (still) {
          stillPath = await storeFile(accountId, still, 'webp');
        }
      }
    }
    const path = await storeFile(accountId, bytes, 'webm');
    return {
      account_id: accountId, path, still_path: stillPath, still_from_frame: false, format: 'webm',
      width: sideOf(sticker.width), height: sideOf(sticker.height), emoji, position,
    };
  }
  const size = await stillWebp(bytes);
  if (!size) {
    return null;
  }
  const path = await storeFile(accountId, bytes, 'webp');
  return { account_id: accountId, path, still_path: null, still_from_frame: false, format: 'webp', width: size.width, height: size.height, emoji, position };
}

// Runs work(item, index) over items, a few at a time, in order of results.
async function inBatches(items, work) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index], index);
      } catch (cause) {
        console.warn('[helloevents] sticker copy:', errorDetail(cause));
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));
  return results;
}

// Adds the pack a link names to the account. Throws with code
// 'sticker_pack_link' (not a pack link), 'sticker_pack_exists',
// 'sticker_pack_limit', 'sticker_pack_not_found' (Telegram has none by that
// name) or 'sticker_pack_empty' (nothing in it could be copied: all
// animated, say). Returns the pack's id.
export async function addPack(accountId, typed) {
  const name = packNameFrom(typed);
  if (!name) {
    throw fail('sticker_pack_link');
  }
  const { data: existing, error } = await database().from(TABLES.stickerPacks).select('id, name').eq('account_id', accountId);
  if (error) {
    throw error;
  }
  let packs = [];
  if (Array.isArray(existing)) {
    packs = existing;
  }
  if (packs.some((pack) => pack.name.toLowerCase() === name.toLowerCase())) {
    throw fail('sticker_pack_exists');
  }
  if (packs.length >= PACK_LIMIT) {
    throw fail('sticker_pack_limit', { limit: PACK_LIMIT });
  }
  let set;
  try {
    set = await botResult('getStickerSet', { name });
  } catch (cause) {
    if (cause.code === 'telegram_refused') {
      throw fail('sticker_pack_not_found');
    }
    throw cause;
  }
  let stickers = [];
  if (set && Array.isArray(set.stickers)) {
    stickers = set.stickers.slice(0, STICKERS_PER_PACK);
  }
  const copied = (await inBatches(stickers, (sticker, index) => copySticker(accountId, sticker, index))).filter(Boolean);
  if (copied.length === 0) {
    throw fail('sticker_pack_empty');
  }
  let title = name;
  if (set && typeof set.title === 'string' && set.title.trim()) {
    title = set.title.trim().slice(0, 128);
  }
  const { data: pack, error: packError } = await database()
    .from(TABLES.stickerPacks)
    .insert({ account_id: accountId, name, title })
    .select('id')
    .single();
  if (packError) {
    await deleteFiles(copied.flatMap((row) => [row.path, row.still_path]));
    if (packError.code === '23505') {
      throw fail('sticker_pack_exists');
    }
    throw packError;
  }
  const { error: rowsError } = await database()
    .from(TABLES.stickers)
    .insert(copied.map((row) => ({ ...row, pack_id: pack.id })));
  if (rowsError) {
    await database().from(TABLES.stickerPacks).delete().eq('id', pack.id);
    await deleteFiles(copied.flatMap((row) => [row.path, row.still_path]));
    throw rowsError;
  }
  return { id: pack.id, copied: copied.length, skipped: stickers.length - copied.length };
}

// The account's packs, oldest first, each with its stickers in pack order.
export async function listPacks(accountId) {
  const { data: packs, error } = await database()
    .from(TABLES.stickerPacks)
    .select('id, name, title, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  const { data: stickers, error: stickerError } = await database()
    .from(TABLES.stickers)
    .select(COLUMNS)
    .eq('account_id', accountId)
    .order('position', { ascending: true });
  if (stickerError) {
    throw stickerError;
  }
  const byPack = new Map();
  let stickerRows = [];
  if (Array.isArray(stickers)) {
    stickerRows = stickers;
  }
  let packRows = [];
  if (Array.isArray(packs)) {
    packRows = packs;
  }
  for (const sticker of stickerRows) {
    if (!byPack.has(sticker.pack_id)) {
      byPack.set(sticker.pack_id, []);
    }
    byPack.get(sticker.pack_id).push(sticker);
  }
  return packRows.map((pack) => {
    let rows = byPack.get(pack.id);
    if (!rows) {
      rows = [];
    }
    return { ...pack, stickers: rows };
  });
}

// Removes one of the account's packs and its files. false when the account
// has no such pack.
export async function removePack(accountId, packId) {
  const { data: rows, error } = await database()
    .from(TABLES.stickers)
    .select('path, still_path')
    .eq('pack_id', packId)
    .eq('account_id', accountId);
  if (error) {
    throw error;
  }
  const { data: removed, error: removeError } = await database()
    .from(TABLES.stickerPacks)
    .delete()
    .eq('id', packId)
    .eq('account_id', accountId)
    .select('id');
  if (removeError) {
    throw removeError;
  }
  if (!Array.isArray(removed) || removed.length === 0) {
    return false;
  }
  let files = [];
  if (Array.isArray(rows)) {
    files = rows.flatMap((row) => [row.path, row.still_path]);
  }
  await deleteFiles(files);
  return true;
}

// A video sticker's still, replaced with the full-size first frame the
// editor's browser drew (bytes: a still WebP). Throws 'not_found' for a
// sticker that is not this account's video sticker, 'cover_invalid' for a
// picture that is not a still WebP, or 'sticker_still_size' for one whose
// size is not the sticker's.
export async function setStill(accountId, stickerId, bytes) {
  const sticker = await stickerById(stickerId);
  if (!sticker || sticker.account_id !== accountId || sticker.format !== 'webm') {
    throw fail('not_found');
  }
  const size = await stillWebp(bytes);
  if (!size) {
    throw fail('cover_invalid');
  }
  if (size.width > sticker.width * 2 || size.height > sticker.height * 2) {
    throw fail('sticker_still_size');
  }
  const path = await storeFile(accountId, bytes, 'webp');
  const { error } = await database()
    .from(TABLES.stickers)
    .update({ still_path: path, still_from_frame: true })
    .eq('id', sticker.id);
  if (error) {
    await deleteFiles([path]);
    throw error;
  }
  await deleteFiles([sticker.still_path]);
  return { ...sticker, still_path: path, still_from_frame: true };
}

// Every sticker file of an account (its stickers and their stills), read
// before the account is deleted: the rows go with it, the files do not.
export async function accountStickerFiles(accountId) {
  const { data, error } = await database().from(TABLES.stickers).select('path, still_path').eq('account_id', accountId);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((row) => [row.path, row.still_path]);
}

// Deletes sticker files (best effort), after their rows are gone.
export async function deleteStickerFiles(paths) {
  await deleteFiles(paths);
}
