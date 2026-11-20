// Event galleries (migrations/019): pictures kept in their own shape, a cover
// cut from one of them, and who may add, see and take out pictures.

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
const { GALLERY_LIMIT } = await import('../api/_lib/gallery.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const detail = await route('events/detail');
const galleryImage = await route('events/gallery-image');
const gallery = await route('manage/gallery');
const cover = await route('manage/cover');
const manage = await route('manage/events');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  useTestRedis(createFakeRedis());
});

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

async function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'harbour-meet',
    title: 'Harbour Meet',
    status: 'published',
    starts_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ends_at: null,
    ...over,
  };
  await db.from('gftvevents_events').insert(row);
  return row;
}

const webp = async (width, height, background = '#3a7bd5') => {
  const bytes = await sharp({ create: { width, height, channels: 3, background } }).webp().toBuffer();
  return `data:image/webp;base64,${bytes.toString('base64')}`;
};

// Calls the route, keeping the picture's bytes as they were sent.
async function picture(b, query) {
  let bytes = null;
  const answer = await b.call((request, response) => {
    const end = response.end;
    response.end = function keepBytes(body) {
      bytes = body;
      end.call(this, '');
    };
    return galleryImage(request, response);
  }, { query });
  return { ...answer, bytes };
}

const nameOf = (url) => new URL(url, 'https://events.example').searchParams.get('v');

test('gallery pictures keep their own shape, with no crop, and show on the event page', async () => {
  const event = await addEvent();
  const editor = await staff('editor', { is_editor: true });

  const tall = await editor.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(600, 1400) } });
  assert.equal(tall.status, 200, JSON.stringify(tall.json));
  assert.deepEqual([tall.json.image.width, tall.json.image.height], [600, 1400]);
  // Larger than the stored size: shrunk to 2000 on its longest side, in shape.
  const wide = await editor.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(2400, 600) } });
  assert.deepEqual([wide.json.image.width, wide.json.image.height], [2000, 500]);
  assert.equal(wide.json.images.length, 2);
  assert.equal(wide.json.limit, GALLERY_LIMIT);
  assert.match(wide.json.image.url, /^\/api\/events\/gallery-image\?slug=harbour-meet&v=[A-Za-z0-9_-]+$/);

  // Added without touching the cover.
  const stored = db.table('gftvevents_events').find((row) => row.id === event.id);
  assert.equal(stored.cover_image_path, null);

  const page = await browser().call(detail, { query: { slug: 'harbour-meet' } });
  assert.deepEqual(page.json.event.gallery, [
    { url: tall.json.image.url, width: 600, height: 1400 },
    { url: wide.json.image.url, width: 2000, height: 500 },
  ]);
  assert.equal(page.body.includes('supabase'), false);

  const shown = await picture(browser(), { slug: 'harbour-meet', v: nameOf(tall.json.image.url) });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/webp');
  assert.match(shown.headers['cache-control'], /public.*immutable/);
  assert.deepEqual([(await sharp(shown.bytes).metadata()).width, (await sharp(shown.bytes).metadata()).height], [600, 1400]);
});

test('a gallery refuses what is not a picture, too small a one, and more than its limit', async () => {
  const event = await addEvent();
  const editor = await staff('editor', { is_editor: true });
  const send = (image) => editor.call(gallery, { method: 'POST', body: { id: event.id, image } });

  assert.equal((await send('data:image/png;base64,iVBORw0KGgo=')).json.error, 'cover_not_webp');
  assert.equal((await send(await webp(300, 300))).json.error, 'cover_too_small', 'under 320 on its longer side');
  assert.equal((await send(await webp(1000, 90))).json.error, 'cover_too_small', 'under 100 on its shorter side');
  assert.equal((await send(await webp(1000, 120))).status, 200, 'a thin banner is fine');

  for (let index = 1; index < GALLERY_LIMIT; index += 1) {
    await db.from('gftvevents_event_images').insert({ event_id: event.id, path: `${event.id}/filler${String(index).padStart(16, '0')}.webp`, width: 800, height: 600 });
  }
  const full = await send(await webp(800, 600));
  assert.equal(full.status, 400);
  assert.equal(full.json.error, 'gallery_full');
});

test('only editors add, list and take out pictures, and an unreleased event\'s go only to them', async () => {
  const event = await addEvent({ slug: 'secret-draft', status: 'draft' });
  const helper = await staff('helper');
  const editor = await staff('editor', { is_editor: true });

  assert.equal((await browser().call(gallery, { query: { id: event.id } })).status, 401);
  assert.equal((await helper.call(gallery, { query: { id: event.id } })).status, 403);
  assert.equal((await helper.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(800, 600) } })).status, 403);
  assert.equal((await editor.call(gallery, { query: { id: crypto.randomUUID() } })).status, 404);

  const added = await editor.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(800, 600) } });
  const query = { slug: 'secret-draft', v: nameOf(added.json.image.url) };
  assert.equal((await picture(browser(), query)).status, 404, 'a draft, signed out');
  assert.equal((await picture(helper, query)).status, 404, 'staff who do not manage events');
  const preview = await picture(editor, query);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['cache-control'], 'private, no-store');
  assert.equal((await picture(editor, { slug: 'secret-draft', v: 'NoSuchNameNoSuchName12' })).status, 404);

  const removed = await editor.call(gallery, { method: 'POST', body: { id: event.id, remove: added.json.image.id } });
  assert.deepEqual(removed.json.images, []);
  assert.equal(db.objects.size, 0, 'its file is deleted');
  assert.equal((await picture(editor, query)).status, 404);
});

test('a cover cut from a gallery picture remembers it, until that picture is taken out', async () => {
  const event = await addEvent();
  const other = await addEvent({ slug: 'other-meet' });
  const editor = await staff('editor', { is_editor: true });
  const added = await editor.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(1200, 1600) } });
  const sourceImageId = added.json.image.id;
  const crop = { x: 0, y: 400, width: 1200, height: 675 };

  const set = await editor.call(cover, { method: 'POST', body: { id: event.id, image: await webp(1200, 675), sourceImageId, crop } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.event.hasCover, true);
  assert.equal(set.json.event.coverSourceId, sourceImageId);
  assert.deepEqual(set.json.event.coverCrop, crop);
  const form = await editor.call(manage, { query: { id: event.id } });
  assert.equal(form.json.event.coverSourceId, sourceImageId);
  assert.deepEqual(form.json.event.coverCrop, crop);

  // Only a picture in this event's gallery, and a crop inside it.
  const elsewhere = await editor.call(gallery, { method: 'POST', body: { id: other.id, image: await webp(800, 600) } });
  const borrowed = await editor.call(cover, { method: 'POST', body: { id: event.id, image: await webp(1200, 675), sourceImageId: elsewhere.json.image.id, crop } });
  assert.equal(borrowed.json.error, 'gallery_image_gone');
  const outside = await editor.call(cover, { method: 'POST', body: { id: event.id, image: await webp(1200, 675), sourceImageId, crop: { ...crop, y: 1000 } } });
  assert.equal(outside.json.error, 'bad_request');
  const noCrop = await editor.call(cover, { method: 'POST', body: { id: event.id, image: await webp(1200, 675), sourceImageId } });
  assert.equal(noCrop.json.error, 'bad_request');

  // Taking the picture out keeps the cover and forgets where it came from.
  const removed = await editor.call(gallery, { method: 'POST', body: { id: event.id, remove: sourceImageId } });
  assert.equal(removed.json.event.hasCover, true);
  assert.equal(removed.json.event.coverSourceId, '');
  assert.equal(removed.json.event.coverCrop, null);

  // Removing the cover forgets it too.
  const again = await editor.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(1200, 1600) } });
  await editor.call(cover, { method: 'POST', body: { id: event.id, image: await webp(1200, 675), sourceImageId: again.json.image.id, crop } });
  const off = await editor.call(cover, { method: 'POST', body: { id: event.id, remove: true } });
  assert.deepEqual([off.json.event.hasCover, off.json.event.coverSourceId, off.json.event.coverCrop], [false, '', null]);
});

test('deleting an event deletes its gallery files', async () => {
  const event = await addEvent();
  const boss = await staff('boss', { is_admin: true });
  await boss.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(800, 600) } });
  await boss.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(600, 800) } });
  assert.equal(db.objects.size, 2);
  const deleted = await boss.call(manage, { method: 'POST', body: { action: 'delete', id: event.id } });
  assert.equal(deleted.status, 200);
  assert.equal(db.objects.size, 0);
  assert.equal(db.table('gftvevents_event_images').length, 0);
});

test('a description\'s crop of a gallery picture is served as that part, only at its exact address', async () => {
  const event = await addEvent();
  const editor = await staff('editor', { is_editor: true });
  const added = await editor.call(gallery, { method: 'POST', body: { id: event.id, image: await webp(1600, 800) } });
  const name = nameOf(added.json.image.url);
  const cropped = await picture(browser(), { slug: 'harbour-meet', v: name, crop: '0.25,0.5,0.5,0.5' });
  assert.equal(cropped.status, 200);
  assert.match(cropped.headers['cache-control'], /public.*immutable/);
  const size = await sharp(cropped.bytes).metadata();
  assert.deepEqual([size.width, size.height, size.format], [800, 400, 'webp']);
  for (const crop of ['0.25,0.5,0.5,0.6', '0.250,0.5,0.5,0.5', 'nope', '0,0,1,1']) {
    assert.equal((await picture(browser(), { slug: 'harbour-meet', v: name, crop })).status, 404, crop);
  }
});
