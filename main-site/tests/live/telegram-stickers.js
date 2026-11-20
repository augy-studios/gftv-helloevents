// A live check of adding a Telegram sticker pack: the real Bot API, with
// everything else in memory (the fake database and Storage that `npm test`
// uses), so nothing is written anywhere real. Not part of `npm test`.
//
// Usage, from main-site, with the bot token in the environment:
//   TELEGRAM_BOT_TOKEN=... node tests/live/telegram-stickers.js [pack link]
// The pack defaults to https://t.me/addstickers/Augy3.
//
// It adds the pack the way /account does (api/_lib/stickers.js addPack),
// then checks every sticker it copied: still stickers are single-frame WebP
// files, video stickers are WebM files with a still WebP, and animated
// (Lottie) stickers were left out. The token is never printed.

import sharp from 'sharp';
import { createFakeDb } from '../fake-db.js';

const link = process.argv[2] || 'https://t.me/addstickers/Augy3';
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set in this shell.');
  process.exit(2);
}
// Never the real database, whatever this shell has.
delete process.env.SUPABASE_SERVICE_KEY;
process.env.SUPABASE_URL = 'https://in-memory.invalid';

const { useTestClient } = await import('../../api/_lib/supabase.js');
const db = createFakeDb();
useTestClient(db);
const { addPack, listPacks } = await import('../../api/_lib/stickers.js');

const account = { id: crypto.randomUUID(), username: 'live-check', display_name: 'Live check', status: 'active' };
await db.from('gftvevents_accounts').insert(account);

const started = Date.now();
let added;
try {
  added = await addPack(account.id, link);
} catch (error) {
  let code = error.code;
  if (!code) {
    code = error.message.replace(process.env.TELEGRAM_BOT_TOKEN, '<token>');
  }
  console.error(`Adding ${link} failed: ${code}`);
  process.exit(1);
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const [pack] = await listPacks(account.id);
console.log(`"${pack.title}" (${pack.name}): ${added.copied} stickers copied, ${added.skipped} left out, in ${seconds} s`);

const bytesOf = (path) => db.objects.get(`gftvevents_stickers/${path}`).body;
const problems = [];
const kinds = { webp: 0, webm: 0 };
for (const sticker of pack.stickers) {
  kinds[sticker.format] += 1;
  if (sticker.format === 'webp') {
    const metadata = await sharp(bytesOf(sticker.path)).metadata();
    if (metadata.format !== 'webp' || (metadata.pages || 1) > 1) {
      problems.push(`${sticker.emoji} is not a still WebP`);
    }
    if (metadata.width !== sticker.width || metadata.height !== sticker.height) {
      problems.push(`${sticker.emoji} size ${metadata.width}x${metadata.height} vs stored ${sticker.width}x${sticker.height}`);
    }
  } else {
    const video = bytesOf(sticker.path);
    if (video[0] !== 0x1a || video[1] !== 0x45 || video[2] !== 0xdf || video[3] !== 0xa3) {
      problems.push(`${sticker.emoji} is not a WebM`);
    }
    if (!sticker.still_path) {
      problems.push(`${sticker.emoji} (video) has no still picture`);
    } else {
      const still = await sharp(bytesOf(sticker.still_path)).metadata();
      if (still.format !== 'webp') {
        problems.push(`${sticker.emoji} (video) still is not a WebP`);
      }
    }
  }
}
console.log(`Still (WebP): ${kinds.webp}, video (WebM + still): ${kinds.webm}`);
console.log(`Emoji: ${pack.stickers.map((sticker) => sticker.emoji).join(' ')}`);
if (problems.length > 0) {
  console.error(`Problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Every sticker checks out.');
