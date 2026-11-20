// Contact details (migrations/021): an editor asks the people going for a
// Telegram username and an email address of their own field, both needed;
// a member is told what is missing or wrong, RSVPs with both, changes one
// later, and the editor sees them on the attendee list.

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
  await expect(status(page)).toHaveText(SAVED);
}

test('an editor asks for contact details, a member gives them with the RSVP, and the editor sees them', async ({ page, context }) => {
  await openEditor(page);
  await openSection(page, 'Price and RSVP');
  // Nothing asked yet: the rule waits for a field.
  await expect(page.locator('#f-contactRule')).toBeDisabled();
  await page.getByLabel('Telegram username').check();
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#f-contactRule')).toBeEnabled();
  await page.locator('#contactAdd').click();
  const label = page.getByLabel('Your field 1: what it asks for');
  await expect(label).toBeFocused();
  await label.fill('Email');
  await page.getByLabel('Your field 1: what is typed in it').selectOption('email');
  await page.locator('#f-contactRule').selectOption('all');
  await expect(status(page)).toHaveText(SAVED);
  // Saved: it comes back the same.
  await page.reload();
  await openSection(page, 'Price and RSVP');
  await expect(page.getByLabel('Telegram username')).toBeChecked();
  await expect(page.getByLabel('Your field 1: what it asks for')).toHaveValue('Email');
  await expect(page.locator('#f-contactRule')).toHaveValue('all');

  // A member: both fields, said to be needed, checked before anything is sent.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  const box = page.locator('#rsvpContact');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Fill in all of these.');
  await expect(box).toContainText('Only the event\'s organisers see these.');
  await expect(page.locator('#rsvpContactSave')).toBeHidden();
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpError')).toHaveText('Fill in Telegram username.');
  await expect(page.locator('#rsvpStatus')).toBeHidden();
  await page.getByLabel('Telegram username').fill('@otter_paws');
  await page.getByLabel('Email').fill('otter at example');
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpError')).toHaveText('Check Email. Such as name@example.com.');
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Email').fill('otter@example.org');
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpStatus')).toBeVisible();

  // Going: the details stay, and can be changed on their own.
  await page.reload();
  await expect(page.getByLabel('Telegram username')).toHaveValue('@otter_paws');
  await expect(page.getByLabel('Email')).toHaveValue('otter@example.org');
  await expect(page.locator('#rsvpContactMissing')).toBeHidden();
  await page.getByLabel('Telegram username').fill('river_otter');
  await page.locator('#rsvpContactSave').click();
  await expect(page.locator('#rsvpContactSaved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Telegram username')).toHaveValue('@river_otter');

  // The editor's attendee list, with a link to the Telegram chat.
  await context.clearCookies();
  await openEditor(page);
  await openSection(page, 'Attendees and notes');
  const row = page.locator('#attendeeList .attendee-row', { hasText: MEMBER.username });
  await expect(row.locator('.attendee-contact')).toHaveText('Telegram username: @river_otter · Email: otter@example.org');
  await expect(row.getByRole('link', { name: '@river_otter' })).toHaveAttribute('href', 'https://t.me/river_otter');
  await expect(row.getByRole('link', { name: 'otter@example.org' })).toHaveAttribute('href', 'mailto:otter@example.org');
});
