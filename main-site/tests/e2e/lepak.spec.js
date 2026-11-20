// "Just Lepak Only" (migrations/017): an editor lets people come to a paid
// convention without a ticket, under their own words and with one place; a
// member picks it, adds a meal, and the editor sees them on the list.

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

test('a member comes to a paid event without a ticket, with lunch, and the editor sees it', async ({ page, context }) => {
  // The editor: lepak on, in their own words, one place.
  await openEditor(page);
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#f-lepakLabel')).toBeDisabled();
  await page.locator('#f-lepakEnabled').check();
  await expect(page.locator('#f-lepakLabel')).toBeEnabled();
  await page.locator('#f-lepakLabel').fill('Just chill');
  await page.locator('#f-lepakLimit').fill('1');
  await page.locator('#f-lepakLimit').blur();
  await expect(status(page)).toHaveText(SAVED);

  // A member: a third choice, with its place count.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  const lepak = page.getByLabel('Just chill (1 place left)');
  await expect(lepak).toBeVisible();
  await lepak.check();
  // Meals can be ticked alongside, but need not be.
  await expect(page.locator('#rsvpMealList')).toBeVisible();
  await expect(page.locator('#rsvpBtn')).toBeEnabled();
  await page.getByLabel('Lunch').check();
  await page.locator('#rsvpBtn').click();
  const rsvpStatus = page.locator('#rsvpStatus');
  await expect(rsvpStatus).toHaveText('You are going: Just chill, with Lunch');
  // No space taken, and the one lepak place is now theirs.
  await expect(page.locator('#factGoing')).toHaveText('0 going');
  await expect(page.getByLabel('Just chill (full)')).toBeChecked();

  // Dropping lunch saves at once and keeps them lepak.
  await page.getByLabel('Lunch').uncheck();
  await expect(rsvpStatus).toHaveText('You are going: Just chill');
  await page.reload();
  await expect(rsvpStatus).toHaveText('You are going: Just chill');

  // The editor's list.
  await context.clearCookies();
  await openEditor(page);
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeesLepak')).toHaveText('Just chill: 1 of 1');
  await expect(page.locator('#attendeeList .attendee-row', { hasText: MEMBER.username })).toContainText('Just chill');
});
