// Each ticket tier its own ways to pay (migrations/016): an editor makes the
// Day pass payable by its own QR code only and the Sponsor tier on the day
// only; a member's checkout offers each ticket only its own ways, and the
// Day pass shows its own QR code.

import sharp from 'sharp';
import { test, expect, serverOrigin, signInAsStaff, enterPassword, openSection } from './fixtures.js';
import { EVENTS, STAFF, MEMBER } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');
const picture = (width, height) => sharp({ create: { width, height, channels: 3, background: '#663399' } }).png().toBuffer();

test('a tier paid by its own QR code only, another on the day only', async ({ page, context }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(status(page)).toHaveText(SAVED);
  await openSection(page, 'Price and RSVP');

  // The event takes payment on the day by default.
  await page.locator('#f-pay-onsite').check();
  await page.locator('#f-tiersEnabled').check();
  const cards = page.locator('#tierList .tier-edit-card');
  const field = (index, key) => cards.nth(index).locator(`[data-key="${key}"]`);
  await field(0, 'name').fill('Day pass');
  await field(0, 'price').fill('45');
  await page.locator('#tierAdd').click();
  await field(1, 'name').fill('Sponsor');
  await field(1, 'price').fill('120');
  await page.locator('#f-priceNote').click();
  await expect(status(page)).toHaveText(SAVED);

  // The Day pass: by QR code only, its own; ticked without one, it says so.
  await field(0, 'pay-qr').check();
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#paymentProblems li')).toHaveText(['Day pass: upload a QR code for this tier, or the event\'s, to offer it.']);
  await cards.nth(0).locator('.tier-qr-file').setInputFiles({ name: 'day.png', mimeType: 'image/png', buffer: await picture(240, 600) });
  await expect(cards.nth(0).locator('.tier-qr-preview')).toBeVisible();
  await expect(page.locator('#paymentProblems')).toBeHidden();
  // The Sponsor tier: on the day only.
  await field(1, 'pay-onsite').check();
  await expect(status(page)).toHaveText(SAVED);
  // Kept by a reload, QR code and all.
  await page.reload();
  await openSection(page, 'Price and RSVP');
  await expect(field(0, 'pay-qr')).toBeChecked();
  await expect(cards.nth(0).locator('.tier-qr-preview')).toBeVisible();

  // A member's checkout: each ticket its own ways to pay.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await expect(page.locator('#ticketTiers .tier-methods')).toHaveText(['Pay by: QR code', 'Pay by: Pay on the day']);
  await page.locator('#rsvpCheckout').click();
  await page.waitForURL(/\/checkout\?slug=/);
  const methods = page.locator('#methodList .choice-title');
  const ticket = (name) => page.locator('#ticketList').getByRole('checkbox', { name });
  await expect(ticket(/^Day pass/)).toBeChecked();
  await expect(methods).toHaveText(['QR code']);
  // Both tickets: they share no way to pay, so they cannot go together.
  await ticket(/^Sponsor/).check();
  await expect(page.locator('#pickProblem')).toHaveText('These tickets are paid for in different ways, so they cannot be bought together. Pick tickets that can be paid for the same way.');
  await expect(page.locator('#reserveBtn')).toBeDisabled();
  await ticket(/^Day pass/).uncheck();
  await expect(page.locator('#pickProblem')).toBeHidden();
  await expect(methods).toHaveText(['Pay on the day']);
  await ticket(/^Day pass/).check();
  await ticket(/^Sponsor/).uncheck();
  await expect(methods).toHaveText(['QR code']);
  await page.locator('#reserveBtn').click();
  // Its own QR code: the tall one.
  await expect(page.locator('#payQr')).toBeVisible();
  expect(await page.locator('#payQr').evaluate((image) => image.naturalHeight > image.naturalWidth * 2)).toBe(true);
  // No other way to switch to: the Day pass takes only its QR code.
  await expect(page.locator('#switchBox')).toBeHidden();
});

// Several tiers at once (migrations/022): an attendee pass once, and a day
// pass the editor lets one person buy up to 3 of, paid for together.
test('one person buys two tiers at once, more than one of a tier only where the editor allows it', async ({ page, context }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(status(page)).toHaveText(SAVED);
  await openSection(page, 'Price and RSVP');
  await page.locator('#f-pay-link').check();
  await page.locator('#f-paymentLink').fill('https://pay.example.org/lion-city');
  await page.locator('#f-tiersEnabled').check();
  const cards = page.locator('#tierList .tier-edit-card');
  const field = (index, key) => cards.nth(index).locator(`[data-key="${key}"]`);
  await field(0, 'name').fill('Attendee');
  await field(0, 'price').fill('60');
  await page.locator('#tierAdd').click();
  await field(1, 'name').fill('Day pass');
  await field(1, 'price').fill('25');
  await field(1, 'multiple').check();
  await field(1, 'maxPerPerson').fill('3');
  await page.locator('#f-priceNote').click();
  await expect(status(page)).toHaveText(SAVED);

  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await page.locator('#rsvpCheckout').click();
  await page.waitForURL(/\/checkout\?slug=/);
  const ticket = (name) => page.locator('#ticketList').getByRole('checkbox', { name });
  // The attendee pass is bought once: no "How many" for it.
  await expect(ticket(/^Attendee/)).toBeChecked();
  await expect(page.locator('#ticketList .ticket-quantity')).toHaveCount(0);
  await ticket(/^Day pass/).check();
  const quantity = page.locator('#ticketList .ticket-quantity input');
  await expect(quantity).toHaveValue('1');
  await quantity.fill('5');
  await quantity.press('Tab');
  // No more than the editor allows.
  await expect(quantity).toHaveValue('3');
  await quantity.fill('2');
  await quantity.press('Tab');
  await expect(page.locator('#orderLines dt')).toHaveText(['Attendee', 'Day pass × 2', 'To pay', 'Paying by']);
  await expect(page.locator('#orderLines dd').nth(2)).toHaveText('SGD 110.00');
  await page.locator('#reserveBtn').click();
  await expect(page.locator('#payLines dd').first()).toHaveText('Attendee, Day pass × 2');
  await expect(page.locator('#payLines dd').nth(1)).toHaveText('SGD 110.00');
  await expect(page.locator('#payLink')).toHaveAttribute('href', 'https://pay.example.org/lion-city');
});
