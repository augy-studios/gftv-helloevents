// The Word-like description editor: toolbar formatting, pasting from Word
// and Google Docs with the formatting kept, pictures pasted from elsewhere
// copied into the gallery, pictures put in from the gallery, and the event
// page showing it all under the site's Content-Security-Policy.

import sharp from 'sharp';
import { test, expect, serverOrigin, signInAsStaff } from './fixtures.js';
import { EVENTS, STAFF } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');
const editor = (page) => page.locator('#f-description');

async function openEvent(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  await expect(status(page)).toHaveText(SAVED);
}

// Pastes into the editor the way Ctrl+V does, with this HTML (and text) on
// the clipboard.
async function pasteHtml(page, html, text = '') {
  await editor(page).evaluate((element, { pastedHtml, pastedText }) => {
    const data = new DataTransfer();
    data.setData('text/html', pastedHtml);
    data.setData('text/plain', pastedText);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { pastedHtml: html, pastedText: text });
}

// Puts the cursor at the end of the editor.
async function cursorAtEnd(page) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
}

// Leaves the editor, which saves the form.
async function saveByLeaving(page) {
  await page.locator('#f-summary').click();
  await expect(status(page)).toHaveText(SAVED);
}

test('the toolbar formats text as Word does, and the event page shows it', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await editor(page).click();
  await page.keyboard.type('Schedule');
  await page.locator('#richBlock').selectOption('h2');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Doors open at ');
  await page.locator('#richToolbar [data-command="bold"]').click();
  await page.keyboard.type('7pm');
  await page.locator('#richToolbar [data-command="bold"]').click();
  await expect(page.locator('#richToolbar [data-command="bold"]')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.type(' sharp.');
  await page.keyboard.press('Enter');
  await page.locator('#richToolbar [data-command="insertUnorderedList"]').click();
  await page.keyboard.type('Bring ID');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Dress up');

  // A colour from the palette, on a selected word.
  await page.keyboard.press('Shift+Home');
  await page.locator('#richToolbar [data-command="colour"]').click();
  await page.locator('#colourPalette .rich-swatch[aria-label="#ff0000"]').click();
  await expect(editor(page).locator('li span')).toHaveCSS('color', 'rgb(255, 0, 0)');

  await saveByLeaving(page);
  await page.goto(`/e/${event.slug}`);
  const description = page.locator('#eventDescription');
  await expect(description.locator('h2')).toHaveText('Schedule');
  await expect(description.locator('strong')).toHaveText('7pm');
  await expect(description.locator('li')).toHaveText(['Bring ID', 'Dress up']);
  // Styles show even though the page's policy forbids style attributes.
  await expect(description.locator('li span')).toHaveCSS('color', 'rgb(255, 0, 0)');
});

test('text pasted from Word or Google Docs keeps its formatting; Automatic black follows the theme', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await cursorAtEnd(page);
  await pasteHtml(page, '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">'
    + '<h1 dir="ltr"><span style="font-size:20pt;color:#000000;">Big title</span></h1>'
    + '<p dir="ltr" style="text-align:center"><span style="color:#000000;font-weight:700;">Bold</span> '
    + '<span style="color:#1155cc;text-decoration:underline;font-style:italic;font-family:Georgia,serif;">blue link-ish</span> '
    + '<span style="background-color:#ffff00;">highlighted</span></p>'
    + '<ul><li><p>First</p></li><li><p>Second</p></li></ul>'
    + '<table><tbody><tr><td><p>Time</p></td><td><p>Panel</p></td></tr></tbody></table></b>', 'Big title Bold');
  const h2 = editor(page).locator('h2');
  await expect(h2).toHaveText('Big title');
  await expect(editor(page).locator('p[style*="center"] strong')).toHaveText('Bold');
  const blue = editor(page).locator('em u span');
  await expect(blue).toHaveCSS('color', 'rgb(17, 85, 204)');
  await expect(blue).toHaveCSS('font-family', /Georgia/);
  await expect(editor(page).locator('span', { hasText: 'highlighted' })).toHaveCSS('background-color', 'rgb(255, 255, 0)');
  await expect(editor(page).locator('li')).toHaveText(['First', 'Second']);
  await expect(editor(page).locator('td')).toHaveText(['Time', 'Panel']);
  // Black text pasted from Docs carries no colour of its own: it follows the theme.
  expect(await h2.locator('span').getAttribute('style')).not.toContain('color');

  await saveByLeaving(page);
  await page.goto(`/e/${event.slug}`);
  const description = page.locator('#eventDescription');
  await expect(description.locator('h2')).toHaveText('Big title');
  await expect(description.locator('em u span')).toHaveCSS('color', 'rgb(17, 85, 204)');
  await expect(description.locator('td')).toHaveText(['Time', 'Panel']);
});

test('pictures in a paste are copied into the gallery, where they were', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await cursorAtEnd(page);
  const dataPicture = `data:image/png;base64,${(await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c8285a' } }).png().toBuffer()).toString('base64')}`;
  await pasteHtml(page, `<p>Before <img src="https://pictures.e2e.test/800x400.png"> middle <img src="${dataPicture}"> after <img src="file:///C:/Users/x/clip_image001.png"></p>`);
  const pictures = editor(page).locator('img[data-gallery-id]');
  await expect(pictures).toHaveCount(2);
  await expect(editor(page).locator('img[data-pending-src]')).toHaveCount(0);
  await expect(pictures.nth(0)).toHaveAttribute('width', '800');
  await expect(pictures.nth(1)).toHaveAttribute('width', '640');
  await expect(editor(page)).toHaveText('Before  middle  after');
  // Both joined the gallery.
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(2);
  await expect(status(page)).toHaveText(SAVED);

  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventDescription img')).toHaveCount(2);
  await expect.poll(() => page.locator('#eventDescription img').first().evaluate((image) => image.naturalWidth)).toBe(800);
});

test('a gallery picture goes in at the cursor from the picture dialog, and new uploads join the gallery', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await editor(page).click();
  await page.keyboard.type('Start ');
  await page.locator('#richToolbar [data-command="picture"]').click();
  await expect(page.locator('#pictureModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('#pickerGalleryEmpty')).toBeVisible();
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#e9c46a' } }).png().toBuffer();
  await page.locator('#pickerFile').setInputFiles([{ name: 'meet.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.locator('#pictureModal')).toHaveClass(/hidden/);
  await expect(editor(page).locator('img[data-gallery-id]')).toHaveCount(1);
  await expect(page.locator('#galleryList .gallery-item')).toHaveCount(1);
  await page.keyboard.type(' end');
  await expect(editor(page)).toHaveText('Start  end');
  // No line break left behind after the picture.
  await expect(editor(page).locator('img + br')).toHaveCount(0);

  // Again from the gallery tab, which now lists it.
  await page.locator('#richToolbar [data-command="picture"]').click();
  await expect(page.locator('#pickerGallery .picker-item')).toHaveCount(1);
  await page.locator('#pickerGallery .picker-item').click();
  await expect(editor(page).locator('img[data-gallery-id]')).toHaveCount(2);
  await saveByLeaving(page);

  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventDescription img[data-gallery-id]')).toHaveCount(2);
  // The stickers tab says how to add a pack.
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await page.locator('#richToolbar [data-command="picture"]').click();
  await page.locator('#pickerTab-stickers').click();
  await expect(page.locator('#pickerNoPacks')).toBeVisible();
});

test('a table, a link and undo work from the toolbar', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await editor(page).click();
  await page.locator('#richToolbar [data-command="table"]').click();
  await page.locator('#tableRows').fill('2');
  await page.locator('#tableColumns').fill('2');
  await page.locator('#tableForm button[type="submit"]').click();
  await expect(editor(page).locator('tr')).toHaveCount(2);
  await expect(editor(page).locator('th')).toHaveCount(2);
  await editor(page).locator('th').first().click();
  await expect(page.locator('#richTableTools')).toBeVisible();
  await page.locator('#richTableTools [data-command="table:rowBelow"]').click();
  await expect(editor(page).locator('tr')).toHaveCount(3);
  await page.locator('#richTableTools [data-command="table:deleteTable"]').click();
  await expect(editor(page).locator('table')).toHaveCount(0);

  await page.keyboard.type('Tickets');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#linkModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('#linkText')).toHaveValue('Tickets');
  await page.locator('#linkAddress').fill('tickets.example.org');
  await page.locator('#linkForm button[type="submit"]').click();
  await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://tickets.example.org');
  // Undo takes back the last change.
  await page.keyboard.press('End');
  await page.keyboard.type(' oops');
  await expect(editor(page)).toContainText('oops');
  await page.locator('#richToolbar [data-command="undo"]').click();
  await expect(editor(page)).not.toContainText('oops');
  await saveByLeaving(page);
  await page.goto(`/e/${event.slug}`);
  const link = page.locator('#eventDescription a');
  await expect(link).toHaveAttribute('href', 'https://tickets.example.org');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
});

test('clicking a picture in the description opens a crop dialog; the crop is that place\'s own', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await editor(page).click();
  await page.locator('#richToolbar [data-command="picture"]').click();
  const png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#4a86e8' } }).png().toBuffer();
  await page.locator('#pickerFile').setInputFiles([{ name: 'wide.png', mimeType: 'image/png', buffer: png }]);
  const picture = editor(page).locator('img[data-gallery-id]');
  await expect(picture).toHaveCount(1);

  // A click opens the dialog on the whole picture; a square crop is taken.
  await picture.click();
  await expect(page.locator('#pictureCropModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('#pictureCropSize')).toHaveText('1200 × 600 pixels');
  await page.locator('#pictureCropShape').selectOption('1:1');
  await expect(page.locator('#pictureCropSize')).toHaveText('600 × 600 pixels');
  await page.locator('#pictureCropStage').press('-');
  // Shown at half the text's width.
  await page.locator('#pictureSize input[value="medium"]').check();
  await page.locator('#pictureCropUse').click();
  await expect(page.locator('#pictureCropModal')).toHaveClass(/hidden/);
  const cropped = editor(page).locator('img[data-gallery-id]');
  await expect(cropped).toHaveAttribute('data-crop', /^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/);
  await expect(cropped).toHaveAttribute('data-size', 'medium');
  const halfWidth = await editor(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return (element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 2;
  });
  expect(Math.abs((await cropped.boundingBox()).width - halfWidth)).toBeLessThan(2);
  // Text typed after it sits beside it, on the same line, as in Word.
  await page.keyboard.press('End');
  await page.keyboard.type(' beside');
  const textBottom = await editor(page).evaluate((element) => {
    const range = document.createRange();
    const text = [...element.querySelector('p').childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).pop();
    range.selectNodeContents(text);
    return range.getBoundingClientRect().bottom;
  });
  const pictureBox = await cropped.boundingBox();
  expect(Math.abs(textBottom - (pictureBox.y + pictureBox.height))).toBeLessThan(12);
  const width = Number(await cropped.getAttribute('width'));
  expect(width).toBe(Number(await cropped.getAttribute('height')));
  expect(width).toBeLessThan(600);
  await expect.poll(() => cropped.evaluate((image) => image.naturalWidth)).toBe(width);
  await expect(status(page)).toHaveText(SAVED);

  // The event page shows the cropped part; the gallery keeps the whole picture.
  await page.goto(`/e/${event.slug}`);
  const shown = page.locator('#eventDescription img');
  await expect(shown).toHaveAttribute('src', /&crop=/);
  await expect(shown).toHaveAttribute('data-size', 'medium');
  await expect.poll(() => shown.evaluate((image) => image.naturalHeight)).toBe(width);
  await expect(page.locator('#eventGallery img')).toHaveAttribute('width', '1200');

  // Opened again it starts on that crop; "Full picture" takes it off, and undo puts it back.
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await editor(page).locator('img[data-gallery-id]').click();
  await expect(page.locator('#pictureCropSize')).toHaveText(`${width} × ${width} pixels`);
  await page.locator('#pictureCropFull').click();
  await expect(editor(page).locator('img[data-gallery-id]')).not.toHaveAttribute('data-crop');
  await expect(editor(page).locator('img[data-gallery-id]')).toHaveAttribute('width', '1200');
  await page.locator('#richToolbar [data-command="undo"]').click();
  await expect(editor(page).locator('img[data-gallery-id]')).toHaveAttribute('data-crop', /,/);
});

test('the emoji picker puts in any emoji of the latest edition, with skin tones, and the page can show them', async ({ page }) => {
  await openEvent(page);
  await editor(page).fill('');
  await editor(page).click();
  await page.keyboard.type('Hi ');
  // The emoji list arrives late; what is typed meanwhile is still searched.
  await page.route('**/assets/emoji/emoji.json', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.locator('#richToolbar [data-command="emoji"]').click();
  await expect(page.locator('#emojiPalette')).toBeVisible();
  await expect(page.locator('#emojiSearch')).toBeFocused();

  // Searched by name, straight away: an Emoji 18.0 one.
  await page.locator('#emojiSearch').fill('cracking face');
  await expect(page.locator('#emojiVersion')).toHaveText(/^Emoji \d+\.\d+$/);
  await expect(page.locator('#emojiHeading')).toHaveText('Search results');
  await page.locator('#emojiGrid .emoji-item[aria-label="cracking face"]').click();
  // A skin tone, then a waving hand in it; the picker stays open for more.
  await page.locator('#emojiTones [aria-label="Medium skin tone"]').click();
  await page.locator('#emojiSearch').fill('waving hand');
  await page.locator('#emojiGrid .emoji-item[aria-label="waving hand"]').click();
  await expect(page.locator('#emojiPalette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#emojiPalette')).toBeHidden();
  await expect(editor(page)).toHaveText('Hi 🫫👋🏽');
  // Typing goes on where the emoji went in.
  await page.keyboard.type('!');
  await expect(editor(page)).toHaveText('Hi 🫫👋🏽!');

  // Recently used comes first next time.
  await page.locator('#richToolbar [data-command="emoji"]').click();
  await page.locator('#emojiTabs [data-group="recent"]').click();
  await expect(page.locator('#emojiGrid .emoji-item')).toHaveText(['👋🏽', '🫫']);
  await page.keyboard.press('Escape');
  await saveByLeaving(page);

  // The event page shows them; a device without an emoji gets it from the
  // site's own emoji font.
  const fontLoaded = page.waitForResponse((response) => response.url().includes('/assets/fonts/emoji/') && response.status() === 200);
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventDescription')).toHaveText('Hi 🫫👋🏽!');
  await fontLoaded;
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "GFTV Emoji"', '🫫'))).toBe(true);
});
