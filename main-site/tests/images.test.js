// Pictures served from this site (api/events/cover.js, api/me/avatar.js), so
// the Supabase Storage address never reaches a browser: what the pages are
// given, who may load an unreleased event's cover, and which profile
// pictures are fetched at all.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';
import { createFakeRedis } from './fake-redis.js';

process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { useTestRedis } = await import('../api/_lib/redis.js');
const { totpAt } = await import('../api/_lib/totp.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const sessionRoute = await route('auth/session');
const feed = await route('events/feed');
const detail = await route('events/detail');
const cover = await route('events/cover');
const avatar = await route('me/avatar');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const COVER = '0b6a3c7e-1f7a-4a0e-9b1e-2f6d7c8a9e01/AbCdEfGhIjKlMnOpQrStUv.webp';
const DRAFT_COVER = COVER.replace('AbCd', 'ZyXw');
let db;
let fetched;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
  fetched = [];
});

// The profile picture's host, answered here rather than over the network.
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer();
  return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
};

async function staff(username, over = {}) {
  await db.from('gftvhello_users').insert({
    username,
    display_name: username,
    email: `${username}@gftv.example`,
    password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true,
    totp_secret: SHARED_SECRET,
    ...over,
  });
  const b = browser();
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  return b;
}

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'harbour-meet',
    title: 'Harbour Meet',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ends_at: null,
    cover_image_path: COVER,
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

async function storeCoverPicture(path) {
  const webp = await sharp({ create: { width: 800, height: 450, channels: 3, background: '#c8285a' } }).webp().toBuffer();
  await db.storage.from('gftvevents_covers').upload(path, webp, { contentType: 'image/webp' });
}

// Calls the route, keeping the picture's bytes as they were sent.
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

test('the pages get covers from this site, never from Storage', async () => {
  addEvent();
  const card = (await browser().call(feed, { query: { when: 'upcoming' } })).json.events[0];
  assert.equal(card.coverImageUrl, '/api/events/cover?slug=harbour-meet&v=AbCdEfGhIjKlMnOpQrStUv');
  const page = await browser().call(detail, { query: { slug: 'harbour-meet' } });
  assert.equal(page.json.event.coverImageUrl, card.coverImageUrl);
  assert.equal(page.body.includes('supabase'), false);
});

test('a released event cover is public and cached; an unreleased one goes only to editors', async () => {
  addEvent();
  addEvent({ slug: 'secret-draft', status: 'draft', cover_image_path: DRAFT_COVER });
  await storeCoverPicture(COVER);
  await storeCoverPicture(DRAFT_COVER);

  const shown = await picture(browser(), cover, { slug: 'harbour-meet', v: 'AbCdEfGhIjKlMnOpQrStUv' });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/webp');
  assert.match(shown.headers['cache-control'], /public.*immutable/);
  assert.equal((await sharp(shown.bytes).metadata()).width, 800);

  const old = await picture(browser(), cover, { slug: 'harbour-meet', v: 'OldNameOldNameOldName1' });
  assert.equal(old.status, 404, 'an old address');
  assert.equal(old.headers['cache-control'], 'no-store');
  assert.equal((await picture(browser(), cover, { slug: 'harbour-meet' })).status, 404);

  const draft = { slug: 'secret-draft', v: 'ZyXwEfGhIjKlMnOpQrStUv' };
  assert.equal((await picture(browser(), cover, draft)).status, 404, 'a draft, signed out');
  assert.equal((await picture(await staff('helper'), cover, draft)).status, 404, 'staff who do not manage events');
  const editor = await picture(await staff('editor', { is_editor: true }), cover, draft);
  assert.equal(editor.status, 200, 'an editor previewing it');
  assert.equal(editor.headers['cache-control'], 'private, no-store');
});

test('a profile picture is served from this site, and only fetched from this Supabase project', async () => {
  const fox = await staff('fox', { avatar_url: 'https://project.supabase.co/storage/v1/object/public/avatars/fox.png' });
  const me = (await fox.call(sessionRoute)).json.user;
  assert.match(me.avatarUrl, /^\/api\/me\/avatar\?v=[0-9a-f]{12}$/);
  const shown = await picture(fox, avatar, {});
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/png');
  assert.equal(shown.headers['cache-control'], 'private, max-age=86400');
  assert.deepEqual(fetched, ['https://project.supabase.co/storage/v1/object/public/avatars/fox.png']);

  // Anywhere else is neither shown nor fetched.
  const owl = await staff('owl', { avatar_url: 'https://elsewhere.example/owl.png' });
  assert.equal((await owl.call(sessionRoute)).json.user.avatarUrl, null);
  assert.equal((await picture(owl, avatar, {})).status, 404);
  assert.equal(fetched.length, 1);
  assert.equal((await picture(browser(), avatar, {})).status, 401, 'signed out');
});
