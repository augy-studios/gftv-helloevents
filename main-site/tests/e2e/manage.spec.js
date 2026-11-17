// Manage, for a staff editor: sign in with the authenticator app, create an
// event, edit it, and see the change on the public page and in the feed;
// an event with its times to be confirmed and several locations; and the
// staff tools in their own tabs.

import { test, expect, serverOrigin, signInAsStaff } from './fixtures.js';
import { EVENTS, STAFF } from './seed.js';

const NEW_EVENT = {
  title: 'Riverside Sketch Meet',
  slug: 'riverside-sketch-meet',
  summary: 'Bring a sketchbook; we draw the river and each other.',
  description: 'Pencils provided. We move indoors if it rains.',
  descriptionZh: '提供铅笔。下雨就移到室内。',
  startDate: '2032-05-02',
  startTime: '15:00',
  endTime: '17:00',
  venueName: 'Riverside Point',
  city: 'Singapore',
  country: 'SG',
  capacity: '15',
  staffNotes: 'Bring spare easels.',
};

const EDITED = {
  title: 'Riverside Sketch and Paint Meet',
  venueName: 'Clarke Quay Central',
};

async function openManage(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await expect(page.locator('#listBox')).toHaveAttribute('aria-busy', 'false');
}

// The nth location card's field.
const locationField = (page, index, key) => page.locator('#locationList .location-card').nth(index).locator(`[data-key="${key}"]`);

test('an editor creates an event in Manage, edits it, and the public page and feed show the change', async ({ page }) => {
  await openManage(page);

  // Every event, drafts included, for editors.
  const list = page.locator('#eventList');
  for (const event of Object.values(EVENTS)) {
    await expect(list.locator('.item-title', { hasText: event.title })).toHaveCount(1);
  }
  const draftRow = list.locator('li', { hasText: EVENTS.draft.title });
  await expect(draftRow.locator('.chip')).toHaveText('Draft');
  await expect(page.locator('header [data-when="manager"]')).toBeVisible();
  // Fewer than ten events: one page, no pager.
  await expect(page.locator('#listPager')).toBeHidden();

  // Create. The form takes the list's place; there is no address field.
  await page.locator('#newEvent').click();
  await expect(page.locator('#editorTitle')).toHaveText('New event');
  await expect(page.locator('#listBox')).toBeHidden();
  await expect(page.locator('#f-slug')).toHaveCount(0);
  await expect(page.locator('#f-timezone')).toHaveValue('Asia/Singapore');
  await expect(page.locator('#descriptionSwitch [data-lang="en"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#f-descriptionZh')).toBeHidden();
  await expect(page.locator('#locationList .location-card')).toHaveCount(1);
  await expect(locationField(page, 0, 'label')).toHaveValue('event');
  // Singapore, Malaysia and Indonesia come first in the country list.
  const countries = await locationField(page, 0, 'country').locator('option').evaluateAll((options) => options.slice(1, 4).map((option) => option.value));
  expect(countries).toEqual(['SG', 'MY', 'ID']);

  await page.locator('#f-title').fill(NEW_EVENT.title);
  await page.locator('#f-summary').fill(NEW_EVENT.summary);
  await page.locator('#f-description').fill(NEW_EVENT.description);
  // The Chinese one is still blank: marked on the switcher.
  await expect(page.locator('#descriptionSwitch [data-lang="zh"] .missing-mark')).toBeVisible();
  await expect(page.locator('#descriptionSwitch [data-lang="en"] .missing-mark')).toBeHidden();
  await page.locator('#f-startDate').fill(NEW_EVENT.startDate);
  await page.locator('#f-startTime').fill(NEW_EVENT.startTime);
  await page.locator('#f-endTime').fill(NEW_EVENT.endTime);
  await locationField(page, 0, 'venueName').fill(NEW_EVENT.venueName);
  await locationField(page, 0, 'city').fill(NEW_EVENT.city);
  await locationField(page, 0, 'country').selectOption(NEW_EVENT.country);
  await page.locator('#f-capacity').fill(NEW_EVENT.capacity);
  await page.locator('#f-status').selectOption('published');
  await page.locator('#f-staffNotes').fill(NEW_EVENT.staffNotes);
  // Both descriptions are required: saving without the Chinese one opens it.
  await page.locator('#editorSave').click();
  await expect(page.locator('#editorError')).toHaveText('Check this field: Description (Chinese).');
  await expect(page.locator('#f-descriptionZh')).toBeVisible();
  await expect(page.locator('#f-descriptionZh')).toBeFocused();
  await expect(page.locator('#f-description')).toBeHidden();
  await page.locator('#f-descriptionZh').fill(NEW_EVENT.descriptionZh);
  await expect(page.locator('#descriptionSwitch [data-lang="zh"] .missing-mark')).toBeHidden();
  await page.locator('#editorSave').click();

  await expect(page.locator('#manageNotice')).toHaveText('Saved.');
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${NEW_EVENT.title}`);
  await expect(page.locator('#editorError')).toHaveText('');
  // The address was made from the title.
  await expect(page.locator('#editorView')).toHaveAttribute('href', `/e/${NEW_EVENT.slug}`);
  await expect(page.locator('#f-startDate')).toHaveValue(NEW_EVENT.startDate);
  await expect(page.locator('#f-startTime')).toHaveValue(NEW_EVENT.startTime);
  // An end time with no end date ends on the start date.
  await expect(page.locator('#f-endDate')).toHaveValue(NEW_EVENT.startDate);
  await expect(page.locator('#attendeesTitle')).toHaveText('0 people going');
  const newRow = list.locator('li', { hasText: NEW_EVENT.title });
  await expect(newRow.locator('.chip')).toHaveText('Published');

  // Edit. A new title keeps the address.
  await page.locator('#f-title').fill(EDITED.title);
  await locationField(page, 0, 'venueName').fill(EDITED.venueName);
  await page.locator('#editorSave').click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${EDITED.title}`);
  await expect(list.locator('.item-title', { hasText: EDITED.title })).toHaveCount(1);
  await expect(page.locator('#editorView')).toHaveAttribute('href', `/e/${NEW_EVENT.slug}`);

  // Opened again from the list, the form holds the saved values.
  await page.locator('#editorClose').click();
  await expect(page.locator('#eventForm')).toBeHidden();
  await expect(page.locator('#listBox')).toBeVisible();
  await page.getByRole('button', { name: `Edit ${EDITED.title}` }).click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${EDITED.title}`);
  await expect(locationField(page, 0, 'venueName')).toHaveValue(EDITED.venueName);
  await expect(locationField(page, 0, 'country')).toHaveValue(NEW_EVENT.country);
  await expect(page.locator('#f-staffNotes')).toHaveValue(NEW_EVENT.staffNotes);
  await expect(page.locator('#f-capacity')).toHaveValue(NEW_EVENT.capacity);

  // The public page has the change, and not the staff notes.
  await page.goto(`/e/${NEW_EVENT.slug}`);
  await expect(page.locator('#eventView')).toBeVisible();
  await expect(page.locator('#eventTitle')).toHaveText(EDITED.title);
  await expect(page.locator('#eventSummary')).toHaveText(NEW_EVENT.summary);
  await expect(page.locator('#eventDescription')).toHaveText(NEW_EVENT.description);
  await expect(page.locator('#eventDescription')).toHaveAttribute('lang', 'en');
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await expect(page.locator('#eventDescription')).toHaveText(NEW_EVENT.descriptionZh);
  await expect(page.locator('#eventDescription')).toHaveAttribute('lang', 'zh');
  await expect(page.locator('#factWhen')).toHaveText(/^Sun, May 2, 2032, 3:00\sPM to 5:00\sPM GMT\+8$/);
  await expect(page.locator('#factWhere')).toHaveText(`${EDITED.venueName}, Singapore, Singapore`);
  await expect(page.locator('#factGoing')).toHaveText('0 of 15 spaces taken');
  await expect(page.locator('#manageLink')).toHaveAttribute('href', `/manage?slug=${NEW_EVENT.slug}`);
  await expect(page.getByText(NEW_EVENT.staffNotes)).toHaveCount(0);

  // And it takes its place in the feed by date.
  await page.goto('/');
  await expect(page.locator('#feed .event-card-title')).toHaveText([EVENTS.furmeet.title, EDITED.title, EVENTS.convention.title]);
});

test('an event with its times to be confirmed, both descriptions and three locations', async ({ page }) => {
  await openManage(page);
  await page.locator('#newEvent').click();
  await page.locator('#f-title').fill('Johor Day Trip');
  await page.locator('#f-description').fill('A day out in Johor Bahru!');
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await expect(page.locator('#f-descriptionZh')).toHaveAttribute('lang', 'zh');
  await page.locator('#f-descriptionZh').fill('一起去新山玩！');
  // Dates only: the times are still to be confirmed.
  await page.locator('#f-startDate').fill('2032-06-12');
  await page.locator('#f-endDate').fill('2032-06-13');
  await page.locator('#f-timezone').selectOption('Asia/Kuala_Lumpur');

  await locationField(page, 0, 'venueName').fill('Mid Valley Southkey');
  await locationField(page, 0, 'city').fill('Johor Bahru');
  await locationField(page, 0, 'country').selectOption('MY');
  // A second location is a meeting location by default.
  await page.locator('#locationAdd').click();
  await expect(locationField(page, 1, 'label')).toHaveValue('meeting');
  await locationField(page, 1, 'venueName').fill('Woodlands Checkpoint');
  await locationField(page, 1, 'country').selectOption('SG');
  // A third, with a label of the editor's own.
  await page.locator('#locationAdd').click();
  await locationField(page, 2, 'label').selectOption('custom');
  await expect(locationField(page, 2, 'customLabel')).toBeVisible();
  await locationField(page, 2, 'customLabel').fill('Dinner');
  await locationField(page, 2, 'venueName').fill('Tepian Tebrau');
  await page.locator('#f-status').selectOption('published');
  await page.locator('#editorSave').click();
  await expect(page.locator('#manageNotice')).toHaveText('Saved.');

  // The times come back blank, as they were left.
  await expect(page.locator('#f-startTime')).toHaveValue('');
  await expect(page.locator('#f-endTime')).toHaveValue('');
  await expect(page.locator('#f-endDate')).toHaveValue('2032-06-13');
  await expect(page.locator('#locationList .location-card')).toHaveCount(3);

  await page.goto('/e/johor-day-trip');
  await expect(page.locator('#eventView')).toBeVisible();
  await expect(page.locator('#factWhen')).toHaveText('Sat, Jun 12, 2032 to Sun, Jun 13, 2032 (time to be confirmed)');
  await expect(page.locator('#eventDescription')).toHaveText('A day out in Johor Bahru!');
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await expect(page.locator('#eventDescription')).toHaveText('一起去新山玩！');
  await expect(page.locator('#eventDescription')).toHaveAttribute('lang', 'zh');
  // The pick is remembered for the next visit.
  await page.reload();
  await expect(page.locator('#eventDescription')).toHaveText('一起去新山玩！');
  await expect(page.locator('#factWhere .location-heading')).toHaveText(['Event location', 'Meeting location', 'Dinner']);
  await expect(page.locator('#factWhere')).toContainText('Mid Valley Southkey, Johor Bahru, Malaysia');
  await expect(page.locator('#factWhere')).toContainText('Woodlands Checkpoint, Singapore');
});

test('the event list shows ten events a page', async ({ page }) => {
  await openManage(page);
  const seeded = Object.keys(EVENTS).length;
  const added = 12;
  // Made through the API from the signed-in page, the way the form saves.
  await page.evaluate(async (count) => {
    for (let number = 1; number <= count; number += 1) {
      const event = { title: `Paged Meet ${number}`, description: 'A meet.', descriptionZh: '聚会。', kind:
 'furmeet', status: 'draft', priceType: 'free', startDate: '2033-01-01' };
      const response = await fetch('/api/manage/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', event }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
    }
  }, added);
  await page.reload();
  await expect(page.locator('#listBox')).toHaveAttribute('aria-busy', 'false');

  const total = seeded + added;
  const pages = Math.ceil(total / 10);
  const rows = page.locator('#eventList > li');
  await expect(page.locator('#listPager')).toBeVisible();
  await expect(page.locator('#pageInfo')).toHaveText(`Page 1 of ${pages}`);
  await expect(rows).toHaveCount(10);
  await expect(page.locator('#pagePrev')).toBeDisabled();

  await page.locator('#pageNext').click();
  await expect(page.locator('#pageInfo')).toHaveText(`Page 2 of ${pages}`);
  await expect(rows).toHaveCount(Math.min(10, total - 10));
  await page.locator('#pagePrev').click();
  await expect(rows).toHaveCount(10);
});

test('the staff tools are tabs, and the open tab is kept in the address', async ({ page }) => {
  await openManage(page);
  const tabs = page.getByRole('tablist');
  await expect(tabs.getByRole('tab')).toHaveText(['Events', 'Venue sign-ups']);
  await expect(page.locator('#allowanceBox')).toBeHidden();

  await tabs.getByRole('tab', { name: 'Venue sign-ups' }).click();
  await expect(page.locator('#allowanceBox')).toBeVisible();
  await expect(page.locator('#listBox')).toBeHidden();
  await expect(page).toHaveURL(/#signups$/);

  // The arrow keys move between the tabs.
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Events' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#listBox')).toBeVisible();

  // Opened again at #signups, that tab opens.
  await page.goto('/manage#signups');
  await expect(page.locator('#allowanceBox')).toBeVisible();
  // New event goes back to the Events tab.
  await page.locator('#newEvent').click();
  await expect(page.locator('#eventForm')).toBeVisible();
  await expect(page.locator('#allowanceBox')).toBeHidden();
});
