// A cross-border event (migrations/015): an editor picks what the link button
// says and ticks "Cross-border event"; a visitor is asked to sign in for the
// link, a member with no country of origin is sent to set one and brought
// back, then can RSVP; the editor sees where they are from.

import { test, expect, serverOrigin, signInAsStaff, enterPassword, openSection } from './fixtures.js';
import { EVENTS, STAFF, MEMBER } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');

test('a cross-border event asks for a country of origin before the link or an RSVP', async ({ page, context }) => {
  // The editor: a group link, labelled as one, and cross-border.
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#externalUrlCustomField')).toBeHidden();
  await page.locator('#f-externalUrl').fill('https://t.me/lioncityfurcon');
  await page.locator('#f-externalUrlLabel').selectOption('custom');
  await expect(page.locator('#externalUrlCustomField')).toBeVisible();
  await page.locator('#f-externalUrlCustomLabel').fill('Join our Telegram');
  await page.locator('#f-crossBorder').check();
  await expect(status(page)).toHaveText(SAVED);

  // Unticked, then Kind set to Convention again: ticked by itself.
  await page.locator('#f-crossBorder').uncheck();
  await page.locator('#f-kind').selectOption('furmeet');
  await expect(page.locator('#f-crossBorder')).not.toBeChecked();
  await page.locator('#f-kind').selectOption('convention');
  await expect(page.locator('#f-crossBorder')).toBeChecked();
  await expect(status(page)).toHaveText(SAVED);

  // Signed out: the button names the link, and signs in first.
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventChips')).toContainText('Cross-border');
  const link = page.locator('#externalLink');
  await expect(link).toHaveText('Join our Telegram');
  await expect(link).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/e/${event.slug}`)}`);
  await expect(page.locator('#externalLinkNote')).toHaveText('Sign in to open this link.');

  // A member with no country: no RSVP button, and both ways lead to setting one.
  await link.click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await expect(page.locator('#rsvpCountry')).toBeVisible();
  await expect(page.locator('#rsvpBtn')).toBeHidden();
  await expect(page.locator('#externalLinkNote')).toHaveText('Add your country of origin to your account to open this link.');
  await page.locator('#rsvpCountryLink').click();
  await expect(page.getByRole('tab', { name: /^Profile/ })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#countryInput').selectOption('MY');
  await page.locator('#countrySubmit').click();

  // Back on the event: the link opens, and the RSVP goes through.
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await expect(page.locator('#rsvpCountry')).toBeHidden();
  await expect(link).toHaveAttribute('href', 'https://t.me/lioncityfurcon');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(page.locator('#externalLinkNote')).toBeHidden();
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpStatus')).toBeVisible();

  // The editor sees where they are from.
  await context.clearCookies();
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeesCountries')).toHaveText('From: Malaysia 1');
  await expect(page.locator('#attendeeList')).toContainText('Malaysia');
});
