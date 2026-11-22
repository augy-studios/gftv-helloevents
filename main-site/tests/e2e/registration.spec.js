// Registration forms (migrations/024): an editor switches the form on and
// picks its questions, a member fills in their account details once,
// registers with the form (photo and all), sees their "Registration
// details" card and changes an answer with its pencil, and the editor sees
// the answers on the attendee list.

import sharp from 'sharp';
import { test, expect, serverOrigin, signInAsStaff, enterPassword, openSection } from './fixtures.js';
import { EVENTS, STAFF, MEMBER } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');

async function openEditor(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
}

test('an editor sets up a registration form; a member registers, then changes an answer from the card', async ({ page, context }) => {
  await openEditor(page);
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#registrationFieldsBox')).toBeHidden();
  await page.locator('#f-registrationEnabled').check();
  await expect(status(page)).toHaveText(SAVED);
  // The ready-made questions start ticked; the account ones do not.
  const preset = (id) => page.locator(`[data-reg-on="${id}"]`);
  await expect(preset('badgeName')).toBeChecked();
  await expect(preset('tshirt')).toBeChecked();
  await expect(preset('legalName')).not.toBeChecked();
  await preset('legalName').check();
  await expect(status(page)).toHaveText(SAVED);
  await preset('nfcUrl').uncheck();
  await preset('handlers').uncheck();
  await preset('guardian').uncheck();
  await preset('donation').uncheck();
  await expect(status(page)).toHaveText(SAVED);
  // A question of the editor's own.
  await page.locator('#registrationAdd').click();
  const card = page.locator('.reg-custom-card').first();
  await card.locator('[data-key="label"]').fill('Dietary needs');
  await card.locator('[data-key="hint"]').fill('Allergies, vegetarian, and so on.');
  await card.locator('[data-key="hint"]').blur();
  await expect(status(page)).toHaveText(SAVED);

  // A member: the form, and their legal name still to fill in.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  const form = page.locator('#rsvpRegistration');
  await expect(form).toBeVisible();
  await expect(form).toContainText('Badge name');
  await expect(form).toContainText('Dietary needs (optional)');
  await form.getByRole('link', { name: 'Fill in my details' }).click();
  await expect(page.getByRole('tab', { name: /^Profile/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#personalNeeded')).toContainText('Legal name');
  await page.locator('#legalNameInput').fill('Otter Tan');
  await page.locator('#countrySubmit').click();
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);

  // Registering: a required question left out is named.
  await expect(form).toContainText('Otter Tan');
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpError')).toHaveText('Badge name: this is required.');
  await page.locator('#rsvpReg-badgeName').fill('Otter');
  await page.locator('#rsvpReg-fursuiting-no').check();
  await page.locator('#rsvpReg-tshirt').selectOption('S');
  const picture = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#66cc88' } }).png().toBuffer();
  await form.locator('input[type="file"]').setInputFiles({ name: 'badge.png', mimeType: 'image/png', buffer: picture });
  await expect(form).toContainText('Photo added.');
  await page.locator('#rsvpReg-conduct').check();
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpStatus')).toBeVisible();

  // The card: badge name, badge number, legal name, every answer.
  const registration = page.locator('#registrationBox');
  await expect(registration).toBeVisible();
  await expect(registration.locator('.reg-badge-name')).toHaveText('Otter');
  await expect(registration).toContainText('Badge: 1');
  await expect(registration).toContainText('Otter Tan');
  await expect(registration).toContainText('T-shirt size');
  await expect(registration.locator('.reg-photo-shown')).toBeVisible();
  await registration.screenshot({ path: 'tests/e2e/output/registration-card.png' });

  // Changing the T-shirt size with its pencil.
  await registration.getByRole('button', { name: 'Change T-shirt size' }).click();
  await registration.locator('#regCard-tshirt').selectOption('M');
  await registration.getByRole('button', { name: 'Save' }).click();
  await expect(registration.locator('.reg-row', { hasText: 'T-shirt size' })).toContainText('M');
  await page.reload();
  await expect(registration.locator('.reg-row', { hasText: 'T-shirt size' })).toContainText('M');

  // The editor sees the answers.
  await context.clearCookies();
  await openEditor(page);
  await openSection(page, 'Attendees and notes');
  const row = page.locator('#attendeeList li', { hasText: MEMBER.username });
  await row.locator('summary').click();
  await expect(row).toContainText('Otter Tan');
  await expect(row).toContainText('Badge name');
  await expect(row).toContainText('Otter');
  await expect(row.getByRole('link', { name: 'Open the photo' })).toBeVisible();
});

test('a donation goes on top of the ticket, and an upgrade asks only the difference', async ({ page, context }) => {
  await openEditor(page);
  await openSection(page, 'Price and RSVP');
  // Two tiers, paid by link.
  await page.locator('#f-tiersEnabled').check();
  const cards = page.locator('#tierList .tier-edit-card');
  const field = (index, key) => cards.nth(index).locator(`[data-key="${key}"]`);
  await field(0, 'name').fill('Attendee');
  await field(0, 'price').fill('60');
  await page.locator('#tierAdd').click();
  await field(1, 'name').fill('Sponsor');
  await field(1, 'price').fill('175');
  await page.locator('#f-priceNote').click();
  await expect(status(page)).toHaveText(SAVED);
  await page.locator('#f-pay-link').check();
  await page.locator('#f-paymentLink').fill('https://pay.example.com/lcf');
  await page.locator('#f-paymentLink').blur();
  await expect(status(page)).toHaveText(SAVED);
  // A short form: the badge name, a donation and the Code of Conduct.
  await page.locator('#f-registrationEnabled').check();
  for (const id of ['nfcUrl', 'fursuiting', 'handlers', 'badgePhoto', 'tshirt', 'guardian']) {
    await page.locator(`[data-reg-on="${id}"]`).uncheck();
  }
  await expect(status(page)).toHaveText(SAVED);

  // A member gets the Attendee tier with a donation.
  await context.clearCookies();
  await page.goto(`/login?next=${encodeURIComponent(`/checkout?slug=${event.slug}`)}`);
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(/\/checkout\?slug=/);
  await page.locator('#checkoutReg-badgeName').fill('Otter');
  await page.locator('#checkoutReg-donation').fill('25');
  await expect(page.locator('#orderLines')).toContainText('Donation');
  await expect(page.locator('#orderLines')).toContainText('85.00');
  await page.locator('#checkoutReg-conduct').check();
  await page.locator('#reserveBtn').click();
  await expect(page.locator('#payLines')).toContainText('85.00');
  await expect(page.locator('#upgradeBox')).toBeVisible();

  // Paid and confirmed by the editor.
  await page.locator('#payReference').fill('PAY-1');
  await page.locator('#reportSubmit').click();
  await expect(page.locator('#upgradeBox')).toBeHidden();
  await context.clearCookies();
  await openEditor(page);
  await openSection(page, 'Attendees and notes');
  await page.getByRole('checkbox', { name: `${MEMBER.displayName} has paid` }).check();
  await expect(page.getByRole('checkbox', { name: `${MEMBER.displayName} has paid` })).toBeChecked();

  // The card offers the upgrade; checkout asks only the difference.
  await context.clearCookies();
  await page.goto(`/login?next=${encodeURIComponent(`/e/${event.slug}`)}`);
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await expect(page.locator('#registrationBox .reg-tier')).toHaveText('Attendee');
  await page.getByRole('link', { name: 'Upgrade registration tier' }).click();
  await page.waitForURL(/upgrade=1/);
  await expect(page.locator('#upgradeList')).toContainText('Sponsor');
  await expect(page.locator('#upgradeList')).toContainText('115.00 to pay');
  await page.locator('#upgradeBox').screenshot({ path: 'tests/e2e/output/registration-upgrade.png' });
  await page.locator('#upgradeBtn').click();
  await expect(page.locator('#payLines')).toContainText('Sponsor');
  await expect(page.locator('#payLines')).toContainText('Paid before upgrading');
  await expect(page.locator('#payLines')).toContainText('115.00');
  await expect(page.locator('#upgradeBox')).toBeHidden();
  await page.locator('#payBox').screenshot({ path: 'tests/e2e/output/registration-upgraded.png' });
});
