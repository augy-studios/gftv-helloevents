// The edit form's own event link (and what happens when another event has
// it), ticket tiers shown on the event page, and cropping a cover picture
// to the cards' 16:9.

import sharp from 'sharp';
import { test, expect, serverOrigin, signInAsStaff } from './fixtures.js';
import { EVENTS, STAFF } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');

async function openEvent(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  await expect(status(page)).toHaveText(SAVED);
}

test('a custom link is tidied and saved; a taken one says so and can get a random ending', async ({ page }) => {
  await openEvent(page);
  const slug = page.locator('#f-slug');
  await expect(slug).toHaveValue(event.slug);

  // Another event's link: refused, with the two ways on.
  await slug.fill(EVENTS.furmeet.slug);
  await page.locator('#f-summary').click();
  await expect(status(page)).toHaveText('Not saved: Another event already uses that address.');
  await expect(page.locator('#slugTaken')).toBeVisible();
  await expect(page.locator('#slugTakenText')).toContainText(`events.globalfurry.tv/e/${EVENTS.furmeet.slug} is already used by another event.`);

  // "Edit the link" goes back to the field; a new link is tidied and saved.
  await page.locator('#slugEdit').click();
  await expect(slug).toBeFocused();
  await slug.fill('Lion City 2032!');
  await page.locator('#f-summary').click();
  await expect(slug).toHaveValue('lion-city-2032');
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#slugTaken')).toBeHidden();
  await expect(page).toHaveURL(/\/manage\?slug=lion-city-2032#editor$/);
  await expect(page.locator('#editorView')).toHaveAttribute('href', '/e/lion-city-2032');

  // Taken again, then fixed with eight random characters on the end.
  await slug.fill(EVENTS.furmeet.slug);
  await page.locator('#f-summary').click();
  await expect(page.locator('#slugTaken')).toBeVisible();
  await page.locator('#slugRandom').click();
  await expect(slug).toHaveValue(new RegExp(`^${EVENTS.furmeet.slug}-[a-z0-9]{8}$`));
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#slugTaken')).toBeHidden();
  const saved = await slug.inputValue();

  await page.goto(`/e/${saved}`);
  await expect(page.locator('#eventTitle')).toHaveText(event.title);
});

test('ticket tiers, each including the one before, show on the event page', async ({ page }) => {
  await openEvent(page);
  await expect(page.locator('#tierSection')).toBeHidden();
  await page.locator('#f-tiersEnabled').check();
  // A first card to fill in; the From and Up to prices now come from tiers.
  const cards = page.locator('#tierList .tier-edit-card');
  await expect(cards).toHaveCount(1);
  await expect(page.locator('#f-priceMin')).toBeDisabled();
  const field = (index, key) => cards.nth(index).locator(`[data-key="${key}"]`);
  await expect(cards.nth(0).locator('.tier-includes-field')).toBeHidden();
  await field(0, 'name').fill('Day pass');
  await field(0, 'price').fill('45');
  await field(0, 'benefits').fill('Entry on one day\nLanyard');

  await page.locator('#tierAdd').click();
  await field(1, 'name').fill('Weekend');
  await field(1, 'price').fill('80');
  await field(1, 'benefits').fill('All three days');
  await expect(cards.nth(1).locator('.tier-includes-label')).toHaveText('Includes everything in Day pass');
  // Not included until ticked; then it names the tier before it.
  await expect(field(1, 'includesPrevious')).not.toBeChecked();
  await expect(field(1, 'previousDisplay')).toBeHidden();
  await field(1, 'includesPrevious').check();
  await expect(field(1, 'previousDisplay')).toHaveValue('reference');

  await page.locator('#tierAdd').click();
  await field(2, 'name').fill('Sponsor');
  await field(2, 'price').fill('120');
  await field(2, 'benefits').fill('Sponsor badge');
  await field(2, 'includesPrevious').check();
  await field(2, 'previousDisplay').selectOption('full');
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#f-priceMin')).toHaveValue('45');
  await expect(page.locator('#f-priceMax')).toHaveValue('120');

  await page.reload();
  await expect(cards).toHaveCount(3);
  await expect(field(2, 'previousDisplay')).toHaveValue('full');

  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#factPrice')).toHaveText('SGD 45.00 to SGD 120.00');
  const tiers = page.locator('#ticketTiers .tier-card');
  await expect(tiers.locator('.tier-name')).toHaveText(['Day pass', 'Weekend', 'Sponsor']);
  await expect(tiers.locator('.tier-price')).toHaveText(['SGD 45.00', 'SGD 80.00', 'SGD 120.00']);
  await expect(tiers.nth(0).locator('.tier-benefits li')).toHaveText(['Entry on one day', 'Lanyard']);
  await expect(tiers.nth(1).locator('.tier-includes')).toHaveText('Everything in Day pass, plus:');
  await expect(tiers.nth(1).locator('.tier-benefits li')).toHaveText(['All three days']);
  // In full: everything the Weekend tier gives, then its own.
  await expect(tiers.nth(2).locator('.tier-includes')).toHaveCount(0);
  await expect(tiers.nth(2).locator('.tier-benefits li')).toHaveText([
    'Entry on one day(included from an earlier tier)',
    'Lanyard(included from an earlier tier)',
    'All three days(included from an earlier tier)',
    'Sponsor badge',
  ]);
});

// A portrait picture in three bands, red over green over blue.
async function portraitPng() {
  const band = (r, g, b) => ({ create: { width: 600, height: 300, channels: 3, background: { r, g, b } } });
  return sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: await sharp(band(255, 0, 0)).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(band(0, 255, 0)).png().toBuffer(), top: 300, left: 0 },
      { input: await sharp(band(0, 0, 255)).png().toBuffer(), top: 600, left: 0 },
    ])
    .png()
    .toBuffer();
}

// The size of the cover the page uploaded, and the colour at its middle.
async function uploaded(request) {
  const image = Buffer.from(request.postDataJSON().image.split(',')[1], 'base64');
  const { width, height } = await sharp(image).metadata();
  const middle = await sharp(image).extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 }).raw().toBuffer();
  return { width, height, middle: [...middle.subarray(0, 3)] };
}

test('a portrait cover is cropped to 16:9, from the middle, and can be cropped again', async ({ page }) => {
  await openEvent(page);
  await page.locator('#coverFile').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: await portraitPng() });
  await expect(page.locator('#cropModal')).toBeVisible();
  await expect(page.locator('#cropLede')).toHaveText(/^This picture is not landscape/);
  await expect(page.locator('#cropCanvas')).toBeFocused();

  // As it starts: the middle of the picture, the green band.
  let upload = page.waitForRequest('**/api/manage/cover');
  await page.locator('#cropUse').click();
  let cover = await uploaded(await upload);
  expect(cover.width).toBe(600);
  expect(cover.height).toBe(Math.round(600 * 9 / 16));
  expect(cover.middle[1]).toBeGreaterThan(200);
  await expect(page.locator('#cropModal')).toBeHidden();
  await expect(page.locator('#coverAdjust')).toBeVisible();
  await expect(page.locator('#coverRemove')).toBeVisible();

  // Again, moved all the way down with the keyboard and zoomed in: blue.
  await page.locator('#coverAdjust').click();
  await expect(page.locator('#cropModal')).toBeVisible();
  for (let step = 0; step < 20; step += 1) {
    await page.locator('#cropCanvas').press('Shift+ArrowDown');
  }
  await page.locator('#cropCanvas').press('+');
  upload = page.waitForRequest('**/api/manage/cover');
  await page.locator('#cropUse').click();
  cover = await uploaded(await upload);
  expect(cover.width / cover.height).toBeCloseTo(16 / 9, 1);
  expect(cover.width).toBeLessThan(600);
  expect(cover.middle[2]).toBeGreaterThan(200);
  expect(cover.middle[1]).toBeLessThan(60);

  // Closing the dialog uploads nothing.
  await page.locator('#coverAdjust').click();
  let sent = false;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/manage/cover')) {
      sent = true;
    }
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#cropModal')).toBeHidden();
  expect(sent).toBe(false);
});
