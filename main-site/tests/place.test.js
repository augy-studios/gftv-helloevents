// Google Maps links on the edit form (api/manage/place.js, api/_lib/maps-link.js):
// editors only; a short link is followed only on Google's own hosts; the
// place comes from the link's pin or, failing that, its name and address,
// with the city, country and street from Nominatim. The network is faked:
// every outgoing request is recorded and answered here.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { browser } from './harness.js';
import { createFakeDb } from './fake-db.js';

process.env.SITE_URL = 'https://events.globalfurry.tv';

const { useTestClient } = await import('../api/_lib/supabase.js');
const { totpAt } = await import('../api/_lib/totp.js');
const route = async (path) => (await import(`../api/${path}.js`)).default;
const login = await route('auth/login');
const verify = await route('auth/verify');
const signup = await route('auth/signup');
const place = await route('manage/place');

const SHARED_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const ION_PIN = 'https://www.google.com/maps/place/ION+Orchard/@1.304,103.831,17z/data=!3m1!4b1!4m6!3m5!8m2!3d1.3040029!4d103.8318333';

let db;
let requests;
// url (string start) -> answer, for the faked network.
let answers;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  requests.push({ url, headers: init.headers });
  for (const [start, answer] of Object.entries(answers)) {
    if (url.startsWith(start)) {
      return answer(url);
    }
  }
  throw new Error(`unexpected fetch ${url}`);
};
process.on('exit', () => {
  globalThis.fetch = realFetch;
});

const redirectTo = (location) => () => new Response(null, { status: 302, headers: { location } });
const json = (body) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const NOMINATIM_ION = {
  name: 'ION Orchard',
  address: { house_number: '2', road: 'Orchard Turn', city: 'Singapore', postcode: '238801', country: 'Singapore', country_code: 'sg' },
};

beforeEach(() => {
  db = createFakeDb();
  useTestClient(db);
  requests = [];
  answers = {};
});

let nextIp = 1;
async function staff(username, over = {}) {
  const b = browser();
  const ip = `198.51.100.${nextIp++}`;
  const call = b.call;
  b.call = (handler, opts = {}) => call(handler, { ip, ...opts });
  await db.from('gftvhello_users').insert({
    username, display_name: username, email: `${username}@gftv.example`, password_hash: await bcrypt.hash(PASSWORD, 4),
    is_approved: true, totp_secret: SHARED_SECRET, ...over,
  });
  const r = await b.call(login, { method: 'POST', body: { identifier: username, password: PASSWORD } });
  const v = await b.call(verify, { method: 'POST', body: { challenge: r.json.challenge, method: 'totp', code: totpAt(SHARED_SECRET) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return b;
}

test('only editors can read a link, and only a Google Maps link', async () => {
  assert.equal((await browser().call(place, { method: 'POST', body: { link: ION_PIN } })).status, 401);

  const member = browser();
  await member.call(signup, { method: 'POST', body: { username: 'otter', displayName: 'Otter', email: 'otter@example.com', password: PASSWORD, agree: true } });
  assert.equal((await member.call(place, { method: 'POST', body: { link: ION_PIN } })).status, 403);

  const ed = await staff('editor', { is_editor: true });
  const notMaps = await ed.call(place, { method: 'POST', body: { link: 'https://example.com/where' } });
  assert.equal(notMaps.status, 422);
  assert.equal(notMaps.json.error, 'maps_link_bad');
  assert.equal((await ed.call(place, { method: 'POST', body: { link: '' } })).status, 400);
  assert.equal(requests.length, 0, 'nothing fetched for a refused link');
});

test('a short link is followed to its pin, and the place filled in from it', async () => {
  answers['https://maps.app.goo.gl/'] = redirectTo(ION_PIN);
  answers['https://nominatim.openstreetmap.org/reverse'] = json(NOMINATIM_ION);
  const ed = await staff('editor', { is_editor: true });

  const shared = 'ION Orchard\nhttps://maps.app.goo.gl/abc123';
  const r = await ed.call(place, { method: 'POST', body: { link: shared } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.place, {
    venueName: 'ION Orchard',
    venueAddress: '2 Orchard Turn, 238801',
    city: 'Singapore',
    country: 'SG',
    mapsUrl: 'https://maps.app.goo.gl/abc123',
  });
  const reverse = new URL(requests[1].url);
  assert.equal(reverse.searchParams.get('lat'), '1.3040029');
  assert.equal(reverse.searchParams.get('lon'), '103.8318333');
  assert.match(requests[1].headers['user-agent'], /^GFTV-HelloEvents\//, 'Nominatim asks each app to name itself');
});

test('a search link is looked up by its name and address, which Google already gives', async () => {
  answers['https://nominatim.openstreetmap.org/search'] = json([
    { name: 'Pavilion Kuala Lumpur', address: { road: 'Jalan Bukit Bintang', city: 'Kuala Lumpur', country_code: 'my' } },
  ]);
  const ed = await staff('editor', { is_editor: true });
  const link = 'https://www.google.com/maps/search/?api=1&query=Pavilion+Kuala+Lumpur,+168+Jalan+Bukit+Bintang,+55100+Kuala+Lumpur';
  const r = await ed.call(place, { method: 'POST', body: { link } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.place.venueName, 'Pavilion Kuala Lumpur');
  assert.equal(r.json.place.venueAddress, '168 Jalan Bukit Bintang, 55100 Kuala Lumpur');
  assert.equal(r.json.place.city, 'Kuala Lumpur');
  assert.equal(r.json.place.country, 'MY');
  assert.equal(new URL(requests[0].url).searchParams.get('q'), 'Pavilion Kuala Lumpur, 168 Jalan Bukit Bintang, 55100 Kuala Lumpur');
});

test('a short link that leaves Google is never followed there', async () => {
  answers['https://maps.app.goo.gl/'] = redirectTo('https://evil.example/maps/place/x');
  const ed = await staff('editor', { is_editor: true });
  const r = await ed.call(place, { method: 'POST', body: { link: 'https://maps.app.goo.gl/bad' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'maps_link_unreadable');
  assert.deepEqual(requests.map((request) => new URL(request.url).hostname), ['maps.app.goo.gl']);
});

test('a lookup that fails says so, for the editor to fill in the place by hand', async () => {
  answers['https://nominatim.openstreetmap.org/'] = () => new Response('busy', { status: 503 });
  const ed = await staff('editor', { is_editor: true });
  const r = await ed.call(place, { method: 'POST', body: { link: ION_PIN } });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'maps_lookup_failed');
});
