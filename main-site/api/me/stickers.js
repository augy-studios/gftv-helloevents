// GET  /api/me/stickers                         my sticker packs, with their stickers
// POST /api/me/stickers { action: "add", link }  add a Telegram pack from its link
// POST /api/me/stickers { action: "remove", id } remove one of my packs
// POST /api/me/stickers { action: "still", id, image }
//                        a video sticker's full-size still (the WebM's first
//                        frame, drawn by my browser, as a WebP)
//
// Telegram sticker packs on my account (migrations/020, api/_lib/stickers.js),
// for putting stickers in event descriptions. Only for people who edit
// events (staff editors and admins, and editors of an event). Adding a pack
// needs the bot token (TELEGRAM_BOT_TOKEN): the Bot API lists the pack and
// hands over its files. Every answer carries { packs }, all my packs as they
// now stand.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { botTokenSet } from '../_lib/telegram.js';
import { addPack, listPacks, removePack, setStill, stickerUrl } from '../_lib/stickers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STILL_MAX_BASE64 = Math.ceil((1_000_000 * 4) / 3) + 64;
const KNOWN_ERRORS = new Set(['sticker_pack_link', 'sticker_pack_exists', 'sticker_pack_limit', 'sticker_pack_not_found', 'sticker_pack_empty', 'cover_invalid', 'sticker_still_size']);

// One sticker as the pages show it in a picker: its id (what a description
// stores), its picture (the WebP, or a video sticker's still), its video,
// its size, its emoji, and whether its still is only Telegram's small
// preview (the browser then sends the video's first frame).
function stickerView(sticker) {
  let still = stickerUrl(sticker, 'main');
  let video = '';
  if (sticker.format === 'webm') {
    video = stickerUrl(sticker, 'main');
    still = stickerUrl(sticker, 'still');
  }
  let emoji = '';
  if (sticker.emoji) {
    emoji = sticker.emoji;
  }
  let needsFrame = false;
  if (sticker.format === 'webm' && sticker.still_from_frame !== true) {
    needsFrame = true;
  }
  return {
    id: sticker.id,
    url: still,
    video,
    width: sticker.width,
    height: sticker.height,
    emoji,
    needsFrame,
  };
}

async function packsAnswer(accountId) {
  const packs = await listPacks(accountId);
  return {
    packs: packs.map((pack) => ({ id: pack.id, name: pack.name, title: pack.title, stickers: pack.stickers.map(stickerView) })),
  };
}

function decodeWebp(input) {
  if (typeof input !== 'string' || input.length > STILL_MAX_BASE64 + 32) {
    return null;
  }
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!match) {
    return null;
  }
  return Buffer.from(match[1], 'base64');
}

export default route('me/stickers', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  const accountId = session.user.id;
  if (request.method === 'GET') {
    return ok(response, await packsAnswer(accountId));
  }
  const body = await readJson(request, response, { maxBytes: STILL_MAX_BASE64 + 4096 });
  if (!body) {
    return;
  }

  if (body.action === 'still') {
    if (await limited(request, response, 'stickerStill', [`u:${accountId}`])) {
      return;
    }
    const bytes = decodeWebp(body.image);
    if (!UUID_PATTERN.test(String(body.id)) || !bytes) {
      return fail(response, 400, 'bad_request');
    }
    try {
      await setStill(accountId, String(body.id).toLowerCase(), bytes);
    } catch (error) {
      if (error.code === 'not_found') {
        return fail(response, 404, 'not_found');
      }
      if (KNOWN_ERRORS.has(error.code)) {
        return fail(response, 400, error.code);
      }
      throw error;
    }
    return ok(response, await packsAnswer(accountId));
  }

  if (await limited(request, response, 'stickers', [`u:${accountId}`])) {
    return;
  }
  if (body.action === 'add') {
    if (!botTokenSet()) {
      return fail(response, 503, 'stickers_unavailable');
    }
    let added;
    try {
      added = await addPack(accountId, String(body.link).slice(0, 300));
    } catch (error) {
      if (KNOWN_ERRORS.has(error.code)) {
        let extra = {};
        if (error.limit) {
          extra = { limit: error.limit };
        }
        return fail(response, 400, error.code, extra);
      }
      throw error;
    }
    await audit(request, { action: 'stickers.pack_added', actorId: accountId, details: { stickers: added.copied, skipped: added.skipped } });
    return ok(response, { added: { id: added.id, copied: added.copied, skipped: added.skipped }, ...(await packsAnswer(accountId)) });
  }
  if (body.action === 'remove') {
    if (!UUID_PATTERN.test(String(body.id))) {
      return fail(response, 400, 'bad_request');
    }
    if (!(await removePack(accountId, String(body.id).toLowerCase()))) {
      return fail(response, 404, 'not_found');
    }
    await audit(request, { action: 'stickers.pack_removed', actorId: accountId });
    return ok(response, await packsAnswer(accountId));
  }
  return fail(response, 400, 'bad_request');
});
