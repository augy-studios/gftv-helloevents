// Going to an event and changing your mind, as a public account with no
// second step, starting from the event page's "Sign in to RSVP".

import { test, expect, serverOrigin, enterPassword } from './fixtures.js';
import { EVENTS, MEMBER } from './seed.js';

test('a member signs in from an event page, RSVPs, sees the address, and cancels', async ({ page }) => {
  const event = EVENTS.furmeet;
  const eventUrl = `${serverOrigin()}/e/${event.slug}`;
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await page.waitForURL(/\/login\?next=/);
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(eventUrl);

  const button = page.locator('#rsvpBtn');
  const status = page.locator('#rsvpStatus');
  const going = page.locator('#factGoing');
  const where = page.locator('#factWhere');
  await expect(button).toHaveText('I am going');
  await expect(status).toBeHidden();
  await expect(page.locator('#rsvpSignIn')).toBeHidden();
  await expect(going).toHaveText('1 of 20 spaces taken');

  await button.click();
  await expect(status).toBeVisible();
  await expect(status).toHaveText('You are going');
  // keyfox (seed.js) is #1 here, so this is RSVP #2.
  await expect(page.locator('#rsvpNumber')).toHaveText('Your RSVP ID: #2');
  await expect(button).toHaveText('I can no longer go');
  await expect(going).toHaveText('2 of 20 spaces taken');
  await expect(page.locator('#rsvpNote')).toHaveText('18 spaces left');
  // The attendees-only street address now shows.
  await expect(where.locator('.fact-line')).toHaveText(['Marina Bay Sands Event Plaza, Singapore, Singapore', event.venue_address]);

  // Kept on the server, not just on the page.
  await page.reload();
  await expect(status).toBeVisible();
  await expect(page.locator('#rsvpNumber')).toHaveText('Your RSVP ID: #2');
  // And on the account page's My events.
  await page.goto('/account');
  await expect(page.locator('#rsvpUpcoming .event-card', { hasText: event.title }).locator('.chip-rsvp-number')).toHaveText('RSVP #2');
  // And on the feed's card.
  await page.goto('/');
  await expect(page.locator('#feed .event-card', { hasText: event.title }).locator('.chip-rsvp-number')).toHaveText('RSVP #2');
  await page.goto(`/e/${event.slug}`);
  await expect(button).toHaveText('I can no longer go');
  await expect(going).toHaveText('2 of 20 spaces taken');

  await button.click();
  await expect(status).toBeHidden();
  await expect(page.locator('#rsvpNumber')).toBeHidden();
  await expect(button).toHaveText('I am going');
  await expect(going).toHaveText('1 of 20 spaces taken');
  await expect(page.locator('#rsvpNote')).toHaveText('19 spaces left');
  await expect(where).not.toContainText(event.venue_address);

  await page.reload();
  await expect(button).toHaveText('I am going');
  await expect(going).toHaveText('1 of 20 spaces taken');
});
