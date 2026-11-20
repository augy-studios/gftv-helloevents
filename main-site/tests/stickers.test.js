// Telegram sticker packs on an account (migrations/020), stickers in
// descriptions, and pictures pasted from other websites copied into the
// gallery. Telegram's Bot API and the other website are answered here.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { totpAt } = await import('../api/_lib/totp.js');
const { packNameFrom } = await import('../api/_lib/stickers.js');
const { useTestPictureFetcher, isPrivateAddress, fetchPicture } = await import('../api/_lib/fetch-picture.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const stickers = await route('me/stickers');
const stickerImage = await route('stickers/image');
const manage = await route('manage/events');
const detail = await route('events/detail');
const gallery = await route('manage/gallery');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;
let calls;

// A tiny WebM: the EBML header and its "webm" doc type.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(40)]);
let stillWebp;
let previewWebp;

// The Bot API: a pack "Augy3" with a still, a video and an animated sticker.
globalThis.fetch = async (url, init = {}) => {
  const address = String(url);
  calls.push(address);
  const reply = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  if (address.endsWith('/getStickerSet')) {
    const { name } = JSON.parse(init.body);
    if (name !== 'Augy3') {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: STICKERSET_INVALID' }), { status: 400 });
    }
    return reply({
      name: 'Augy3',
      title: 'Augy stickers',
      stickers: [
        { file_id: 'still-1', width: 512, height: 512, emoji: '😀', is_animated: false, is_video: false },
        { file_id: 'video-1', width: 512, height: 384, emoji: '🎉', is_animated: false, is_video: true, thumbnail: { file_id: 'thumb-1' } },
        { file_id: 'lottie-1', width: 512, height: 512, emoji: '😺', is_animated: true, is_video: false },
      ],
    });
  }
  if (address.endsWith('/getFile')) {
    const { file_id: fileId } = JSON.parse(init.body);
    const paths = { 'still-1': 'stickers/a.webp', 'video-1': 'videos/b.webm', 'thumb-1': 'thumbnails/c.webp', 'lottie-1': 'stickers/d.tgs' };
    return reply({ file_path: paths[fileId] });
  }
  if (address.includes('/file/bot')) {
    if (address.endsWith('a.webp')) {
      return new Response(stillWebp);
    }
    if (address.endsWith('b.webm')) {
      return new Response(WEBM);
    }
    if (address.endsWith('c.webp')) {
      return new Response(previewWebp);
    }
  }
  return new Response('not found', { status: 404 });
};

beforeEach(async () => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
  calls = [];
  stillWebp = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).webp().toBuffer();
  previewWebp = await sharp({ create: { width: 128, height: 96, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).webp().toBuffer();
  useTestPictureFetcher(null);
});

async function staff(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@gftv.example`, password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true, totp_secret: SHARED_SECRET, ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  return b;
}

// Calls a picture route, keeping the bytes it sent.
async function picture(b, handler, query) {
  let bytes = null;
  const answer = await b.call((request, response) => {
    const end = response.end;
    response.end = function keepBytes(body) {
      bytes = body;
      end.call(this, '');
    };
    return handler(request, response);
  }, { query });
  return { ...answer, bytes };
}

const query = (url) => Object.fromEntries(new URL(url, 'https://events.example').searchParams);

test('a pack link is read in every form Telegram uses', () => {
  for (const typed of ['https://t.me/addstickers/Augy3', 't.me/addstickers/Augy3', 'http://telegram.me/addstickers/Augy3/', 'tg://addstickers?set=Augy3', 'Augy3', ' https://t.me/addstickers/Augy3?x=1 ']) {
    assert.equal(packNameFrom(typed), 'Augy3', typed);
  }
  for (const typed of ['https://t.me/joinchat/abc', 'https://evil.example/addstickers/Augy3', 'Augy 3', '../x', '']) {
    assert.equal(packNameFrom(typed), '', typed);
  }
});

test('adding a pack copies its still stickers as WebP and video stickers as WebM with a still, skipping animated ones', async () => {
  const editor = await staff('editor', { is_editor: true });
  const added = await editor.call(stickers, { method: 'POST', body: { action: 'add', link: 'https://t.me/addstickers/Augy3' } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual([added.json.added.copied, added.json.added.skipped], [2, 1]);
  const [pack] = added.json.packs;
  assert.equal(pack.title, 'Augy stickers');
  assert.equal(pack.name, 'Augy3');
  const [still, video] = pack.stickers;
  assert.deepEqual([still.width, still.height, still.emoji, still.video, still.needsFrame], [512, 512, '😀', '', false]);
  assert.deepEqual([video.width, video.height, video.needsFrame], [512, 384, true]);
  assert.notEqual(video.video, '');

  // The still sticker is served as the WebP Telegram had, unchanged.
  const shown = await picture(browser(), stickerImage, query(still.url));
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/webp');
  assert.match(shown.headers['cache-control'], /public.*immutable/);
  assert.deepEqual(Buffer.from(shown.bytes), stillWebp);
  const played = await picture(browser(), stickerImage, query(video.video));
  assert.equal(played.headers['content-type'], 'video/webm');
  assert.deepEqual(Buffer.from(played.bytes), WEBM);
  // Its still starts as Telegram's preview...
  const preview = await picture(browser(), stickerImage, query(video.url));
  assert.equal((await sharp(preview.bytes).metadata()).width, 128);

  // ...and is replaced by the full-size first frame the browser drew.
  const frame = await sharp({ create: { width: 512, height: 384, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 0.7 } } }).webp().toBuffer();
  const upgraded = await editor.call(stickers, { method: 'POST', body: { action: 'still', id: video.id, image: `data:image/webp;base64,${frame.toString('base64')}` } });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
  const after = upgraded.json.packs[0].stickers[1];
  assert.equal(after.needsFrame, false);
  assert.equal((await sharp((await picture(browser(), stickerImage, query(after.url))).bytes).metadata()).width, 512);
  assert.equal((await picture(browser(), stickerImage, query(video.url))).status, 404, 'the old preview is gone');
  // Only on a video sticker.
  assert.equal((await editor.call(stickers, { method: 'POST', body: { action: 'still', id: still.id, image: `data:image/webp;base64,${frame.toString('base64')}` } })).status, 404);

  // The same pack twice, and one Telegram does not know.
  assert.equal((await editor.call(stickers, { method: 'POST', body: { action: 'add', link: 'Augy3' } })).json.error, 'sticker_pack_exists');
  assert.equal((await editor.call(stickers, { method: 'POST', body: { action: 'add', link: 't.me/addstickers/NoSuchPack' } })).json.error, 'sticker_pack_not_found');
  assert.equal((await editor.call(stickers, { method: 'POST', body: { action: 'add', link: 'https://example.org' } })).json.error, 'sticker_pack_link');
  // The bot token never reaches an answer.
  assert.equal(JSON.stringify(added.json).includes('test-token'), false);

  // Removing the pack deletes its files.
  const removed = await editor.call(stickers, { method: 'POST', body: { action: 'remove', id: pack.id } });
  assert.deepEqual(removed.json.packs, []);
  assert.equal([...db.objects.keys()].some((key) => key.startsWith('gftvevents_stickers/')), false);
  assert.equal((await picture(browser(), stickerImage, query(still.url))).status, 404);
});

test('packs are only for people who edit events, and each sees only their own', async () => {
  const helper = await staff('helper');
  assert.equal((await helper.call(stickers)).status, 403);
  assert.equal((await browser().call(stickers)).status, 401);
  const editor = await staff('editor', { is_editor: true });
  const other = await staff('other', { is_editor: true });
  const added = await editor.call(stickers, { method: 'POST', body: { action: 'add', link: 'Augy3' } });
  assert.deepEqual((await other.call(stickers)).json.packs, []);
  assert.equal((await other.call(stickers, { method: 'POST', body: { action: 'remove', id: added.json.packs[0].id } })).status, 404);
});

test('a sticker in a description shows as its picture, with its video for browsers that play it', async () => {
  const editor = await staff('editor', { is_editor: true });
  const added = await editor.call(stickers, { method: 'POST', body: { action: 'add', link: 'Augy3' } });
  const [still, video] = added.json.packs[0].stickers;
  const made = await editor.call(manage, {
    method: 'POST',
    body: {
      action: 'create',
      event: {
        title: 'Sticker Meet', kind: 'furmeet', status: 'published', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'free',
        description: `<p>Hi <img src="${still.url}" data-sticker-id="${still.id}"> <video src="${video.video}" data-sticker-id="${video.id}"></video></p>`,
        descriptionZh: '<p>你好</p>',
      },
    },
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const stored = db.table('gftvevents_events').find((row) => row.slug === made.json.event.slug);
  assert.equal(stored.description, `<p>Hi <img data-sticker-id="${still.id}"> <img data-sticker-id="${video.id}"></p>`);

  const page = await browser().call(detail, { query: { slug: made.json.event.slug } });
  const html = page.json.event.description;
  assert.match(html, new RegExp(`<img class="rich-sticker" src="${still.url.replace(/[?&]/g, (each) => (each === '?' ? '\\?' : '&amp;'))}" width="512" height="512"`));
  assert.ok(html.includes(`data-video="${video.video.replace('&', '&amp;')}"`));
  // The edit form gets the same, so the editor shows the stickers.
  assert.equal(made.json.event.description, html);
});

test('a picture pasted from another website is copied into the gallery', async () => {
  const editor = await staff('editor', { is_editor: true });
  const made = await editor.call(manage, { method: 'POST', body: { action: 'create', event: { title: 'Paste Meet', kind: 'furmeet', status: 'draft', timezone: 'Asia/Singapore', startDate: '2030-01-01', priceType: 'free', description: 'x', descriptionZh: 'y' } } });
  const jpeg = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#2a9d8f' } }).jpeg().toBuffer();
  let asked = null;
  useTestPictureFetcher(async (address) => {
    asked = address;
    return jpeg;
  });
  const copied = await editor.call(gallery, { method: 'POST', body: { id: made.json.event.id, imageUrl: 'https://lh7-us.googleusercontent.com/picture.jpg' } });
  assert.equal(copied.status, 200, JSON.stringify(copied.json));
  assert.equal(asked, 'https://lh7-us.googleusercontent.com/picture.jpg');
  assert.deepEqual([copied.json.image.width, copied.json.image.height], [2000, 1000]);

  useTestPictureFetcher(async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.equal((await editor.call(gallery, { method: 'POST', body: { id: made.json.event.id, imageUrl: 'https://example.org/a.svg' } })).json.error, 'cover_invalid');
});

test('the picture fetcher never reaches private addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  for (const url of ['http://127.0.0.1/x.png', 'http://[::1]/x.png', 'http://169.254.169.254/latest/meta-data', 'http://localhost/x.png', 'file:///etc/passwd', 'ftp://example.org/x.png', 'https://user:pass@example.org/x.png', 'https://example.org:8443/x.png']) {
    await assert.rejects(fetchPicture(url), { code: 'picture_address_refused' }, url);
  }
});
