// The edit form's own event link (and what happens when another event has
// it), ticket tiers shown on the event page, the gallery (pictures in their
// own shape, chosen or pasted in), and cropping a cover picture cut from it
// to the cards' 16:9.

import sharp from 'sharp';
import { test, expect, serverOrigin, signInAsStaff, openSection } from './fixtures.js';
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

test('ticket tiers, each including any other tier, show on the event page', async ({ page }) => {
  await openEvent(page);
  await openSection(page, 'Price and RSVP');
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
  // Not included until a tier is picked; then it names that tier.
  await expect(field(1, 'includes')).toHaveValue('');
  await expect(field(1, 'includes').locator('option')).toHaveText(['No other tier (just its own benefits)', 'Day pass']);
  await expect(field(1, 'previousDisplay')).toBeHidden();
  await field(1, 'includes').selectOption({ label: 'Day pass' });
  await expect(field(1, 'previousDisplay')).toHaveValue('reference');
  // The Day pass cannot include the Weekend back: that would go round.
  await expect(field(0, 'includes').locator('option', { hasText: 'Weekend' })).toBeDisabled();

  await page.locator('#tierAdd').click();
  await field(2, 'name').fill('Sponsor');
  await field(2, 'price').fill('120');
  await field(2, 'benefits').fill('Sponsor badge');
  await field(2, 'includes').selectOption({ label: 'Weekend' });
  await field(2, 'previousDisplay').selectOption('full');
  // Any tier, not just the one before: a dinner that includes the Day pass,
  // which one person can buy up to 3 of.
  await page.locator('#tierAdd').click();
  await field(3, 'name').fill('Dinner');
  await field(3, 'price').fill('30');
  await field(3, 'benefits').fill('Three-course dinner');
  await expect(field(3, 'includes').locator('option')).toHaveText(['No other tier (just its own benefits)', 'Day pass', 'Weekend', 'Sponsor']);
  await field(3, 'includes').selectOption({ label: 'Day pass' });
  await expect(field(3, 'maxPerPerson')).toBeHidden();
  await field(3, 'multiple').check();
  await field(3, 'maxPerPerson').fill('3');
  // A tier card saves once it is left.
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#f-priceMin')).toHaveValue('30');
  await expect(page.locator('#f-priceMax')).toHaveValue('120');

  await page.reload();
  await openSection(page, 'Price and RSVP');
  await expect(cards).toHaveCount(4);
  await expect(field(2, 'previousDisplay')).toHaveValue('full');
  await expect(field(3, 'includes').locator('option:checked')).toHaveText('Day pass');
  await expect(field(3, 'multiple')).toBeChecked();
  await expect(field(3, 'maxPerPerson')).toHaveValue('3');

  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#factPrice')).toHaveText('SGD 30.00 to SGD 120.00');
  const tiers = page.locator('#ticketTiers .tier-card');
  await expect(tiers.locator('.tier-name')).toHaveText(['Day pass', 'Weekend', 'Sponsor', 'Dinner']);
  await expect(tiers.locator('.tier-price')).toHaveText(['SGD 45.00', 'SGD 80.00', 'SGD 120.00', 'SGD 30.00']);
  await expect(tiers.nth(0).locator('.tier-benefits li')).toHaveText(['Entry on one day', 'Lanyard']);
  await expect(tiers.nth(1).locator('.tier-includes')).toHaveText('Everything in Day pass, plus:');
  await expect(tiers.nth(1).locator('.tier-benefits li')).toHaveText(['All three days']);
  // In full: everything the Weekend tier gives, then its own.
  await expect(tiers.nth(2).locator('.tier-includes')).toHaveCount(0);
  await expect(tiers.nth(2).locator('.tier-benefits li')).toHaveText([
    'Entry on one day(included from another tier)',
    'Lanyard(included from another tier)',
    'All three days(included from another tier)',
    'Sponsor badge',
  ]);
  await expect(tiers.nth(3).locator('.tier-includes')).toHaveText('Everything in Day pass, plus:');
  await expect(tiers.nth(3).locator('.tier-methods')).toHaveText('One person can buy up to 3 of these.');
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

// Adds pictures to the gallery the way "Add pictures" does, and waits for
// the gallery to show count of them.
async function addToGallery(page, files, count) {
  await page.locator('#galleryFile').setInputFiles(files);
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(count);
}

// The size of a gallery picture the page uploaded.
async function uploadedSize(request) {
  const image = Buffer.from(request.postDataJSON().image.split(',')[1], 'base64');
  const { width, height } = await sharp(image).metadata();
  return { width, height };
}

test('gallery pictures go up in their own shape, with no crop, and show on the event page', async ({ page }) => {
  await openEvent(page);
  const wide = await sharp({ create: { width: 1200, height: 500, channels: 3, background: '#c8285a' } }).png().toBuffer();
  const uploads = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/manage/gallery') && request.method() === 'POST') {
      uploads.push(request);
    }
  });
  await addToGallery(page, [
    { name: 'tall.png', mimeType: 'image/png', buffer: await portraitPng() },
    { name: 'wide.png', mimeType: 'image/png', buffer: wide },
  ], 2);
  // No crop dialog for the gallery, and the cover is left as it was.
  await expect(page.locator('#cropModal')).toBeHidden();
  await expect(page.locator('#coverPreview img')).toHaveCount(0);
  expect(await Promise.all(uploads.map(uploadedSize))).toEqual([{ width: 600, height: 900 }, { width: 1200, height: 500 }]);
  await expect(page.locator('#galleryCount')).toHaveText('2 of 100 pictures');
  const shown = page.locator('#galleryList img');
  await expect(shown.nth(0)).toHaveAttribute('src', new RegExp(`^/api/events/gallery-image\\?slug=${event.slug}&v=`));
  await expect.poll(() => shown.nth(0).evaluate((image) => image.naturalHeight / image.naturalWidth)).toBe(1.5);

  // A picture too small for the gallery is named, and the others still go.
  const tiny = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#000000' } }).png().toBuffer();
  await page.locator('#galleryFile').setInputFiles([{ name: 'tiny.png', mimeType: 'image/png', buffer: tiny }]);
  await expect(page.locator('#galleryError')).toHaveText(/^tiny\.png: That picture is too small\./);
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(2);

  // The event page lays them out in their own shape, and opens each larger.
  await page.goto(`/e/${event.slug}`);
  const thumbs = page.locator('#eventGallery .gallery-thumb');
  await expect(page.locator('#galleryBox')).toBeVisible();
  await expect(thumbs).toHaveCount(2);
  await expect(thumbs.nth(1).locator('img')).toHaveAttribute('width', '1200');
  await expect(thumbs.nth(1).locator('img')).toHaveAttribute('height', '500');
  await thumbs.nth(0).click();
  await expect(page.locator('#galleryModal')).toBeVisible();
  await expect(page.locator('#galleryModalTitle')).toHaveText('Picture 1 of 2');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#galleryModalTitle')).toHaveText('Picture 2 of 2');
  await page.locator('#galleryNext').click();
  await expect(page.locator('#galleryModalTitle')).toHaveText('Picture 1 of 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('#galleryModal')).toBeHidden();

  // Removing asks once more, then takes it off the page too.
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(2);
  const remove = page.locator('#galleryList .gallery-remove').first();
  await remove.click();
  await expect(remove).toHaveText('Remove?');
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(2);
  await remove.click();
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(1);
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventGallery .gallery-thumb')).toHaveCount(1);
});

test('a gallery picture used as the cover is cropped to 16:9, from the middle, and can be cropped again', async ({ page }) => {
  await openEvent(page);
  await addToGallery(page, [{ name: 'tall.png', mimeType: 'image/png', buffer: await portraitPng() }], 1);
  await expect(page.locator('#cropModal')).toBeHidden();
  await expect(page.locator('#coverAdjust')).toBeHidden();

  await page.locator('#galleryList .gallery-use-cover').click();
  await expect(page.locator('#cropModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('#cropLede')).toHaveText(/^This picture is not landscape/);
  await expect(page.locator('#cropCanvas')).toBeFocused();

  // As it starts: the middle of the picture, the green band.
  let upload = page.waitForRequest('**/api/manage/cover');
  await page.locator('#cropUse').click();
  let request = await upload;
  let cover = await uploaded(request);
  expect(cover.width).toBe(600);
  expect(cover.height).toBe(Math.round(600 * 9 / 16));
  expect(cover.middle[1]).toBeGreaterThan(200);
  expect(request.postDataJSON().sourceImageId).toMatch(/^[0-9a-f-]{36}$/);
  expect(request.postDataJSON().crop.width).toBeCloseTo(600, 0);
  await expect(page.locator('#cropModal')).toBeHidden();
  await expect(page.locator('#coverAdjust')).toBeVisible();
  await expect(page.locator('#coverRemove')).toBeVisible();
  // The picture it came from is marked, its button now "Adjust crop".
  await expect(page.locator('#galleryList .gallery-item.is-cover .gallery-cover-chip')).toHaveText('Cover');
  await expect(page.locator('#galleryList .gallery-use-cover')).toHaveText('Adjust crop');
  // Shown from this site's own address, never the Storage bucket's.
  const preview = page.locator('#coverPreview img');
  await expect(preview).toHaveAttribute('src', new RegExp(`^/api/events/cover\\?slug=${event.slug}&v=`));
  await expect.poll(() => preview.evaluate((image) => image.naturalWidth)).toBe(600);

  // In a later visit, moved all the way down with the keyboard and zoomed
  // in: blue.
  await page.reload();
  await expect(page.locator('#coverAdjust')).toBeVisible();
  await page.locator('#coverAdjust').click();
  await expect(page.locator('#cropModal')).not.toHaveClass(/hidden/);
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

  // Again: it starts where that crop left off (still blue), and closing the
  // dialog uploads nothing.
  await page.locator('#coverAdjust').click();
  await expect(page.locator('#cropModal')).not.toHaveClass(/hidden/);
  let sent = false;
  page.on('request', (each) => {
    if (each.url().endsWith('/api/manage/cover')) {
      sent = true;
    }
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#cropModal')).toBeHidden();
  expect(sent).toBe(false);

  // Taking the picture out of the gallery keeps the cover, without "Adjust crop".
  const remove = page.locator('#galleryList .gallery-remove');
  await remove.click();
  await remove.click();
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(0);
  await expect(page.locator('#coverPreview img')).toHaveCount(1);
  await expect(page.locator('#coverAdjust')).toBeHidden();
  await expect(page.locator('#coverRemove')).toBeVisible();
});

// Pastes a picture into the page the way Ctrl+V does: a paste event whose
// clipboard holds the file (and, with text, some text too) on target.
async function pastePicture(page, target, buffer, { text = null } = {}) {
  await page.locator(target).evaluate((element, { bytes, withText }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    if (withText !== null) {
      data.setData('text/plain', withText);
    }
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { bytes: [...buffer], withText: text });
}

test('a picture pasted into the form goes into the gallery, as if it had been chosen', async ({ page }) => {
  await openEvent(page);
  await expect(page.locator('#galleryPasteHint')).toHaveText('Or copy a picture and paste it here with Ctrl+V (Cmd+V on a Mac).');
  const picture = await portraitPng();

  // Pasted into a text field together with text, the text is pasted and
  // the picture left alone.
  await pastePicture(page, '#f-summary', picture, { text: 'https://example.org/cat.png' });
  await expect(page.locator('#galleryCount')).toHaveText('');
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(0);

  // Pasted from another section: Basics opens, and it joins the gallery,
  // uncropped, with no crop dialog.
  await openSection(page, 'Meals');
  const upload = page.waitForRequest((request) => request.url().endsWith('/api/manage/gallery') && request.method() === 'POST');
  await pastePicture(page, '#epanel-meals', picture);
  await expect(page.locator('#etab-basics')).toHaveAttribute('aria-selected', 'true');
  expect(await uploadedSize(await upload)).toEqual({ width: 600, height: 900 });
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(1);
  await expect(page.locator('#cropModal')).toBeHidden();

  // A new event cannot take one until it has saved, and says so.
  await page.locator('#newEvent').click();
  await expect(page.locator('#editorTitle')).toHaveText('New event');
  await expect(page.locator('#galleryPasteHint')).toBeHidden();
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(0);
  await pastePicture(page, '#eventForm', picture);
  await expect(page.locator('#galleryError')).toHaveText('Pictures can be added once the event has saved.');
});
