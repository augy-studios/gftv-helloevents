// The public event feed on the home page: upcoming events soonest first, the
// "When" and "Kind" pickers, and nothing unreleased.

import { test, expect } from './fixtures.js';
import { EVENTS } from './seed.js';

test('the feed lists upcoming events soonest first, filters by when and kind, and never shows a draft', async ({ page, stubbedRequests }) => {
  await page.goto('/');
  const feed = page.locator('#feed');
  const titles = feed.locator('.event-card-title');
  await expect(feed).toHaveAttribute('aria-busy', 'false');
  await expect(titles).toHaveText([EVENTS.furmeet.title, EVENTS.convention.title]);
  await expect(page.locator('#feedStatus')).toHaveText('2 events shown');
  await expect(page.getByText(EVENTS.draft.title)).toHaveCount(0);

  // A card: the link, the date badge, when, where, the price and who is going.
  const furmeet = feed.locator('a.event-card', { hasText: EVENTS.furmeet.title });
  await expect(furmeet).toHaveAttribute('href', `/e/${EVENTS.furmeet.slug}`);
  await expect(furmeet.locator('.date-badge-day')).toHaveText('13');
  await expect(furmeet.locator('.date-badge-month')).toHaveText('Mar');
  await expect(furmeet.locator('.chip')).toHaveText(['Furmeet']);
  await expect(furmeet.locator('.event-meta li')).toHaveText([
    /^Sat, Mar 13, 2032, 2:00\sPM to 5:00\sPM GMT\+8$/,
    'Marina Bay Sands Event Plaza, Singapore, Singapore',
    'Free',
    '1 going',
  ]);
  const convention = feed.locator('a.event-card', { hasText: EVENTS.convention.title });
  await expect(convention.locator('.event-meta li')).toHaveText([
    /^Fri, Aug 6, 2032, 10:00\sAM to Sun, Aug 8, 2032, 6:00\sPM GMT\+8$/,
    'Suntec Convention Centre, Singapore, Singapore',
    /^SGD\s45\.00 to SGD\s120\.00$/,
  ]);

  // Past events.
  await page.locator('#whenPicker [data-when-filter="past"]').click();
  await expect(page.locator('#whenPicker [data-when-filter="past"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(titles).toHaveText([EVENTS.past.title]);

  // Events whose dates are still to come.
  await page.locator('#whenPicker [data-when-filter="tba"]').click();
  await expect(titles).toHaveText([EVENTS.tba.title]);
  await expect(feed.locator('.event-meta li')).toHaveText(['Dates to be announced', 'Online', 'Free']);

  // Upcoming conventions only.
  await page.locator('#whenPicker [data-when-filter="upcoming"]').click();
  await page.locator('#kindPicker [data-kind="convention"]').click();
  await expect(page.locator('#kindPicker [data-kind="convention"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(titles).toHaveText([EVENTS.convention.title]);
  await expect(page.locator('#feedStatus')).toHaveText('1 event shown');

  // Google Analytics was asked for, and answered by the stub, not the network.
  expect(stubbedRequests.some((url) => url.startsWith('https://www.googletagmanager.com/gtag/js'))).toBe(true);
});
