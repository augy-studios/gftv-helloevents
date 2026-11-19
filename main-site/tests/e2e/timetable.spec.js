// The edit form's Timetable tab, and the event page: a timetable (a table
// with a column per room, or a list, as the visitor picks), then the same
// items as an itinerary (a line with a dot at each time), with what is on
// now highlighted. The browser's clock is frozen at FIXED_NOW (10:00 on Friday
// 13 November 2026 in Singapore), so the items are put on that day.

import { test, expect, serverOrigin, signInAsStaff } from './fixtures.js';
import { EVENTS, STAFF } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');
const DAY = '2026-11-13';
const NEXT_DAY = '2026-11-14';

async function openEvent(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  await expect(status(page)).toHaveText(SAVED);
  await page.locator('#etab-timetable').click();
}

// Fills the newest item card.
async function fillItem(page, { title, date, room, start, end = '', note = '' }) {
  const card = page.locator('.timetable-item-card').last();
  await card.locator('[data-key="title"]').fill(title);
  await card.locator('[data-key="date"]').fill(date);
  if (room !== undefined) {
    await card.locator('[data-key="room"]').selectOption({ label: room });
  }
  await card.locator('[data-key="start"]').fill(start);
  await card.locator('[data-key="end"]').fill(end);
  await card.locator('[data-key="note"]').fill(note);
}

test('an editor builds a timetable, visitors see it as a table or a list, and as an itinerary it is a line of times', async ({ page }) => {
  await openEvent(page);
  await expect(page.locator('#itemsEmpty')).toBeVisible();
  // An itinerary to start with: times only, so no rooms.
  await expect(page.locator('#f-timetableView')).toHaveValue('timeline');
  await expect(page.locator('#roomsFieldset')).toBeHidden();
  await page.locator('#f-timetableView').selectOption('grid');
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#roomsFieldset')).toBeVisible();

  // Two rooms: the item cards offer them by name and tag.
  await page.locator('#roomAdd').click();
  await page.locator('.room-row').last().locator('[data-key="name"]').fill('Panel 1 Jade');
  await page.locator('.room-row').last().locator('[data-key="tag"]').fill('Level G');
  await page.locator('#roomAdd').click();
  await page.locator('.room-row').last().locator('[data-key="name"]').fill('Grand Ballroom');
  await page.locator('#f-timetableView').focus();
  await expect(status(page)).toHaveText(SAVED);

  // A half-filled item waits until its card is left, rather than being refused.
  await page.locator('#itemAdd').click();
  await page.locator('.timetable-item-card').last().locator('[data-key="title"]').fill('Con tags');
  await expect(status(page)).not.toContainText('Not saved');
  await fillItem(page, { title: 'Con tags', date: DAY, room: 'Panel 1 Jade (Level G)', start: '09:30', end: '12:00', note: 'Bring your ticket' });
  await page.locator('#itemAdd').click();
  await expect(page.locator('.timetable-item-card').last().locator('[data-key="date"]')).toHaveValue(DAY);
  await fillItem(page, { title: 'Opening Ceremony', date: DAY, room: 'Grand Ballroom', start: '15:30', end: '16:00' });
  await page.locator('#itemAdd').click();
  await fillItem(page, { title: 'Dance Night', date: DAY, room: 'Grand Ballroom', start: '21:00', end: '01:00' });
  await page.locator('#itemAdd').click();
  await fillItem(page, { title: 'Group Photo', date: NEXT_DAY, room: 'No particular room', start: '11:00' });
  await page.locator('#f-timetableView').focus();
  await expect(status(page)).toHaveText(SAVED);

  // The timetable, as a table: today's rooms, what is on now, the now line.
  await page.goto(`/e/${event.slug}`);
  const box = page.locator('#timetableBox');
  await expect(page.locator('#timetableTitle')).toHaveText('Timetable');
  await expect(page.locator('#timetableZone')).toContainText('Times are in');
  const layout = page.locator('#timetableLayout');
  await expect(layout.locator('[data-layout="table"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#timetableDays .tt-day-btn')).toHaveText(['Fri, Nov 13', 'Sat, Nov 14']);
  await expect(page.locator('#timetableDays [aria-pressed="true"]')).toHaveText('Fri, Nov 13');
  await expect(box.locator('.tt-head-name')).toHaveText(['Panel 1 Jade', 'Grand Ballroom']);
  await expect(box.locator('.tt-head-tag')).toHaveText(['Level G']);
  await expect(box.locator('.tt-block.is-now')).toHaveText(/Con tags/);
  await expect(box.locator('.tt-now-line')).toBeVisible();
  await expect(box.locator('.tt-now-label')).toContainText('Now');

  // The other day: an item in no room has a column of its own.
  await page.locator('#timetableDays .tt-day-btn', { hasText: 'Sat' }).click();
  await expect(box.locator('.tt-head-name')).toHaveText(['Everywhere else']);
  await expect(box.locator('.tt-block')).toHaveText([/Group Photo/]);
  await expect(box.locator('.tt-now-line')).toBeHidden();

  // A visitor can switch the timetable to a list, and it stays a list.
  await layout.locator('[data-layout="list"]').click();
  await expect(layout.locator('[data-layout="list"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#timetableDays')).toBeHidden();
  await expect(box.locator('.tt-grid')).toHaveCount(0);
  const entries = box.locator('.tt-entry');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0)).toHaveClass(/is-now/);
  await expect(entries.nth(0)).toContainText('Panel 1 Jade');
  await expect(entries.nth(2)).toContainText('(next day)');
  await page.reload();
  await expect(box.locator('.tt-entry')).toHaveCount(4);
  await layout.locator('[data-layout="table"]').click();
  await expect(box.locator('.tt-block.is-now')).toHaveText(/Con tags/);

  // Made an itinerary: the rooms and each item's end and room are put away.
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await page.locator('#etab-timetable').click();
  await page.locator('#f-timetableView').selectOption('timeline');
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#roomsFieldset')).toBeHidden();
  const firstCard = page.locator('.timetable-item-card').first();
  await expect(firstCard.locator('[data-key="end"]')).toBeHidden();
  await expect(firstCard.locator('[data-key="room"]')).toBeHidden();
  await expect(firstCard.locator('.item-f-start')).toContainText('Time');

  // The itinerary: a line per day with a dot at each time. The step going
  // on now (until the next one) is reached and ringed; the next one is not.
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#timetableTitle')).toHaveText('Itinerary');
  await expect(layout, 'an itinerary has no Table / List switch').toBeHidden();
  await expect(page.locator('#timetableDays')).toBeHidden();
  await expect(box.locator('.tt-day-title')).toHaveText(['Friday, November 13', 'Saturday, November 14']);
  const stops = box.locator('.tl-stop');
  await expect(stops.locator('.tl-time')).toHaveText(['9:30 AM', '3:30 PM', '9:00 PM', '11:00 AM']);
  await expect(stops.nth(0)).toHaveClass(/is-reached/);
  await expect(stops.nth(0)).toHaveClass(/is-now/);
  await expect(stops.nth(1)).not.toHaveClass(/is-reached/);
  const items = box.locator('.tl-item');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveClass(/is-now/);
  await expect(items.nth(0).locator('.tt-mark-now')).toBeVisible();
  await expect(items.nth(0)).toContainText('Bring your ticket');
  await expect(items.nth(0), 'a step has no room or end').not.toContainText('Panel 1 Jade');
  await expect(items.nth(1).locator('.tt-mark-next')).toBeVisible();
});
