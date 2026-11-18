// Link previews for event pages (api/events/page.js, api/events/embed-image.js):
// a released event's own title, when and where, summary and cover picture;
// nothing for a draft or an event not released yet.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.SUPABASE_URL = 'https://project.supabase.co';

const { useTestClient } = await import('../api/_lib/supabase.js');
const page = (await import('../api/events/page.js')).default;
const embedImage = (await import('../api/events/embed-image.js')).default;

const COVER = '0b6a3c7e-1f7a-4a0e-9b1e-2f6d7c8a9e01/AbCdEfGhIjKlMnOpQrStUv.webp';
let db;

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
});

function addEvent(over = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug: 'harbour-meet',
    title: 'Harbour Meet',
    status: 'published',
    timezone: 'Asia/Singapore',
    starts_at: '2026-12-12T06:00:00.000Z',
    venue_name: 'Marina Hall',
    city: 'Singapore',
    summary: 'An afternoon by the water.',
    description: 'Long description.',
    ...over,
  };
  db.from('gftvevents_events').insert(row).then(() => {});
  return row;
}

async function storeCoverPicture(path = COVER) {
  const webp = await sharp({ create: { width: 800, height: 400, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 1 } } }).webp().toBuffer();
  await db.storage.from('gftvevents_covers').upload(path, webp, { contentType: 'image/webp' });
}

const meta = (html, attribute, name) => {
  const match = html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`));
  if (!match) return null;
  return match[1];
};

test('a released event page carries its own preview tags, with its cover as a JPEG', async () => {
  addEvent({ cover_image_path: COVER });
  const answer = await browser().call(page, { query: { slug: 'harbour-meet' } });
  assert.equal(answer.status, 200);
  assert.match(answer.headers['content-type'], /text\/html/);
  assert.match(answer.headers['cache-control'], /s-maxage=60/);
  const html = answer.body;
  assert.match(html, /<title>Harbour Meet \| GFTV HelloEvents<\/title>/);
  assert.equal(meta(html, 'property', 'og:title'), 'Harbour Meet');
  assert.equal(meta(html, 'property', 'og:type'), 'article');
  assert.equal(meta(html, 'property', 'og:url'), 'https://events.globalfurry.tv/e/harbour-meet');
  assert.match(html, /<link rel="canonical" href="https:\/\/events.globalfurry.tv\/e\/harbour-meet">/);
  assert.equal(meta(html, 'property', 'og:description'), 'Sat, 12 Dec, 2:00 pm SGT · Marina Hall, Singapore. An afternoon by the water.');
  assert.equal(meta(html, 'name', 'description'), meta(html, 'property', 'og:description'));
  const image = 'https://events.globalfurry.tv/api/events/embed-image?slug=harbour-meet&amp;v=AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(meta(html, 'property', 'og:image'), image);
  assert.equal(meta(html, 'name', 'twitter:image'), image);
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta(html, 'property', 'og:image:alt'), 'Harbour Meet');
  // Still the event page: the script that draws the event is there.
  assert.match(html, /<script type="module" src="\/js\/pages\/event.js"><\/script>/);
});

test('without a cover the preview keeps the site picture; text is escaped and clipped', async () => {
  addEvent({ title: 'Paws & "Claws" <Meet>', summary: null, description: `${'word '.repeat(80)}end`, status: 'cancelled', venue_name: null, city: null, is_online: true });
  const html = (await browser().call(page, { query: { slug: 'harbour-meet' } })).body;
  assert.equal(meta(html, 'property', 'og:title'), 'Cancelled: Paws &amp; &quot;Claws&quot; &lt;Meet&gt;');
  assert.equal(meta(html, 'property', 'og:image'), 'https://events.globalfurry.tv/GHE-main.png');
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary');
  const description = meta(html, 'property', 'og:description');
  assert.match(description, /^Cancelled · Sat, 12 Dec, 2:00 pm SGT · online\. word word/);
  assert.ok(description.endsWith('…'));
  assert.ok(description.length <= 240);
  assert.equal(html.includes('<Meet>'), false);
});

test('a draft, an event not released yet, or no event gets the plain page with the site tags', async () => {
  addEvent({ slug: 'secret-draft', status: 'draft', title: 'Secret Draft', cover_image_path: COVER });
  addEvent({ slug: 'later-meet', title: 'Later Meet', publish_at: new Date(Date.now() + 86400_000).toISOString() });
  for (const slug of ['secret-draft', 'later-meet', 'no-such-event', 'Bad Slug!']) {
    const answer = await browser().call(page, { query: { slug } });
    assert.equal(answer.status, 200, slug);
    assert.equal(meta(answer.body, 'property', 'og:title'), 'GFTV HelloEvents', slug);
    assert.equal(answer.body.includes('Secret'), false);
    assert.equal(answer.body.includes('Later Meet'), false);
  }
});

test('the preview picture is the cover as a JPEG, only at its current address', async () => {
  addEvent({ cover_image_path: COVER });
  addEvent({ slug: 'secret-draft', status: 'draft', cover_image_path: COVER.replace('AbCd', 'ZyXw') });
  await storeCoverPicture();
  await storeCoverPicture(COVER.replace('AbCd', 'ZyXw'));

  let jpeg = null;
  const answer = await browser().call(
    (request, response) => embedImage(request, { ...response, end(body) { jpeg = body; response.end(''); } }),
    { query: { slug: 'harbour-meet', v: 'AbCdEfGhIjKlMnOpQrStUv' } }
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'image/jpeg');
  assert.match(answer.headers['cache-control'], /immutable/);
  const info = await sharp(jpeg).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, 800);
  assert.equal(info.height, 400);

  const old = await browser().call(embedImage, { query: { slug: 'harbour-meet', v: 'OldNameOldNameOldName1' } });
  assert.equal(old.status, 404, 'an old cover address');
  const draft = await browser().call(embedImage, { query: { slug: 'secret-draft', v: 'ZyXwEfGhIjKlMnOpQrStUv' } });
  assert.equal(draft.status, 404, 'a draft');
  const none = await browser().call(embedImage, { query: { slug: 'harbour-meet' } });
  assert.equal(none.status, 404, 'no version');
});
