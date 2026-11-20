// Asking who is a fursuiter (migrations/023): an editor ticks it for an
// event, a member says they are one when they RSVP and can take it back,
// and the attendee list shows who said so, with a count.

import { test, expect, serverOrigin, signInAsStaff, enterPassword, openSection } from './fixtures.js';
import { EVENTS, STAFF, MEMBER } from './seed.js';

const event = EVENTS.furmeet;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');

async function openEditor(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
}

test('an editor asks who is a fursuiter; a member says so with their RSVP, and the attendee list shows it', async ({ page, context }) => {
  await openEditor(page);
  // (This event was written before Chinese descriptions were needed.)
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await page.locator('#f-descriptionZh').fill('在喷泉集合。');
  await page.locator('#f-title').click();
  await expect(status(page)).toHaveText(SAVED);
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#f-fursuitersAsked')).not.toBeChecked();
  await page.locator('#f-fursuitersAsked').check();
  await expect(status(page)).toHaveText(SAVED);

  // A member: the box shows with the RSVP, and goes with it.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#rsvpFursuiterRow')).toBeHidden();
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  const box = page.locator('#rsvpFursuiter');
  await expect(page.locator('#rsvpFursuiterRow')).toBeVisible();
  await expect(page.locator('#rsvpFursuiterRow')).toHaveText("I'm a fursuiter");
  await box.check();
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpStatus')).toHaveText('You are going');
  await expect(box).toBeChecked();
  await page.reload();
  await expect(box).toBeChecked();

  // The editor sees it.
  await context.clearCookies();
  await openEditor(page);
  const row = page.locator('#attendeeList li', { hasText: MEMBER.username });
  await expect(row).toContainText('Fursuiter');
  await expect(page.locator('#attendeesFursuiters')).toHaveText('1 fursuiter');

  // Taken back while going: saved at once.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await box.uncheck();
  await expect(box).toBeEnabled();
  await page.reload();
  await expect(box).not.toBeChecked();
});
