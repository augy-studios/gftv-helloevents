// One event's page, /e/<slug> (served from event.html by vercel.json's
// rewrite), as someone who is not signed in sees it.

import { test, expect } from './fixtures.js';
import { EVENTS } from './seed.js';

test('an event page shows the public details, keeps the attendees-only address back, and offers sign-in to RSVP', async ({ page }) => {
  const event = EVENTS.furmeet;
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventView')).toBeVisible();
  await expect(page.locator('#eventLoading')).toBeHidden();
  await expect(page).toHaveTitle(`${event.title} | GFTV HelloEvents`);

  await expect(page.locator('#eventChips .chip')).toHaveText(['Furmeet']);
  await expect(page.locator('#eventTitle')).toHaveText(event.title);
  await expect(page.locator('#eventSummary')).toHaveText(event.summary);
  await expect(page.locator('#eventDescription')).toHaveText(event.description);
  await expect(page.locator('#eventOrganiser')).toHaveText('Organised by SG Furmeets');

  await expect(page.locator('#factWhen')).toHaveText(/^Sat, Mar 13, 2032, 2:00\sPM to 5:00\sPM GMT\+8$/);
  await expect(page.locator('#factWhere .fact-line')).toHaveText([
    'Marina Bay Sands Event Plaza, Singapore, Singapore',
    'The street address is shown to people going.',
  ]);
  await expect(page.locator('#factPrice')).toHaveText('Free');
  await expect(page.locator('#factGoing')).toHaveText('1 of 20 spaces taken');

  // Not signed in: a link to sign in that comes back here, and no RSVP button.
  await expect(page.locator('#rsvpSignIn')).toBeVisible();
  await expect(page.locator('#rsvpSignIn')).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/e/${event.slug}`)}`);
  await expect(page.locator('#rsvpBtn')).toBeHidden();
  await expect(page.locator('#rsvpStatus')).toBeHidden();
  await expect(page.locator('#rsvpNote')).toHaveText('19 spaces left');
  await expect(page.locator('#manageLink')).toBeHidden();
  await expect(page.locator('#previewNote')).toBeHidden();
  await expect(page.locator('header [data-when="signed-out"]')).toBeVisible();

  // What only people going and editors may see is not on the page at all.
  await expect(page.getByText(event.venue_address)).toHaveCount(0);
  await expect(page.getByText(event.staff_notes)).toHaveCount(0);
});
