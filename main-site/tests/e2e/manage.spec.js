// Manage, for a staff editor: sign in with the authenticator app, create an
// event, edit it, and see the change on the public page and in the feed;
// an event with its times to be confirmed and several locations; the form
// saving itself as each field is left; the event list, the edit form and
// the staff tools in their own tabs, and the form's sections in tabs of
// their own; and cancelling an event instead of deleting it.

import { test, expect, serverOrigin, signInAsStaff, openSection } from './fixtures.js';
import { EVENTS, STAFF, ADMIN } from './seed.js';

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

async function openManage(page, username = STAFF.username) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await expect(page.locator('#listBox')).toHaveAttribute('aria-busy', 'false');
}

// The autosave pill at the bottom of the edit form.
const status = (page) => page.locator('#autosaveStatus');
const SAVED = 'All changes saved';

// The nth location card's field.
const locationField = (page, index, key) => page.locator('#locationList .location-card').nth(index).locator(`[data-key="${key}"]`);

test('an editor creates an event in Manage, edits it, and the public page and feed show the change', async ({ page }) => {
  await openManage(page);

  // Every event, drafts included, for editors, by status: Published first,
  // each status with its count.
  const list = page.locator('#eventList');
  const statusButton = (name) => page.locator('#listStatus').getByRole('button', { name });
  await expect(page.locator('#listStatus button')).toHaveText(['Published4', 'Drafts1', 'Cancelled0']);
  await expect(statusButton(/^Published/)).toHaveAttribute('aria-pressed', 'true');
  const published = Object.values(EVENTS).filter((event) => event.status === 'published');
  // Newest change first, which the seed does not fix: compared as a set.
  await expect(list.locator('li')).toHaveCount(published.length);
  expect((await list.locator('.item-title').allInnerTexts()).sort()).toEqual(published.map((event) => event.title).sort());
  await expect(list.locator('.item-title', { hasText: EVENTS.draft.title })).toHaveCount(0);
  await statusButton(/^Drafts/).click();
  const draftRow = list.locator('li', { hasText: EVENTS.draft.title });
  await expect(draftRow.locator('.chip')).toHaveText('Draft');
  await expect(list.locator('li')).toHaveCount(1);
  // No cancelled events: a line says so.
  await statusButton(/^Cancelled/).click();
  await expect(list.locator('li')).toHaveCount(0);
  await expect(page.locator('#listEmptyStatus')).toHaveText('No cancelled events.');
  await statusButton(/^Published/).click();
  await expect(page.locator('header [data-when="manager"]')).toBeVisible();
  // Fewer than ten events: one page, no pager.
  await expect(page.locator('#listPager')).toBeHidden();

  // Create. The form opens in its own tab, with no Save button; the link is
  // blank, to be made from the title.
  await page.locator('#newEvent').click();
  await expect(page.locator('#editorTitle')).toHaveText('New event');
  await expect(page.getByRole('tab', { name: 'Manage event' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#listBox')).toBeHidden();
  await expect(page.locator('#editorSave')).toHaveCount(0);
  await expect(status(page)).toHaveText(/^Saves by itself once it has a title/);
  await expect(page.locator('#f-slug')).toHaveValue('');
  // The form opens on Basics; the other sections are tabs of their own.
  await expect(page.locator('#editorTabs').getByRole('tab')).toHaveText(['Basics', 'When and where', 'Price and RSVP', 'Meals', 'Timetable', 'Attendees and notes', 'ID verification', 'Check-in and entry'], { useInnerText: true });
  await expect(page.locator('#f-startDate')).toBeHidden();
  await openSection(page, 'When and where');
  await expect(page.locator('#f-title')).toBeHidden();
  await expect(page.locator('#f-timezone')).toHaveValue('Asia/Singapore');
  await expect(page.locator('#descriptionSwitch [data-lang="en"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#f-descriptionZh')).toBeHidden();
  await expect(page.locator('#locationList .location-card')).toHaveCount(1);
  await expect(locationField(page, 0, 'label')).toHaveValue('event');
  // Singapore, Malaysia and Indonesia come first in the country list.
  const countries = await locationField(page, 0, 'country').locator('option').evaluateAll((options) => options.slice(1, 4).map((option) => option.value));
  expect(countries).toEqual(['SG', 'MY', 'ID']);

  await openSection(page, 'Basics');
  await page.locator('#f-title').fill(NEW_EVENT.title);
  await page.locator('#f-summary').fill(NEW_EVENT.summary);
  await page.locator('#f-description').fill(NEW_EVENT.description);
  // The Chinese one is still blank: marked on the switcher.
  await expect(page.locator('#descriptionSwitch [data-lang="zh"] .missing-mark')).toBeVisible();
  await expect(page.locator('#descriptionSwitch [data-lang="en"] .missing-mark')).toBeHidden();
  await openSection(page, 'When and where');
  await page.locator('#f-startDate').fill(NEW_EVENT.startDate);
  await page.locator('#f-startTime').fill(NEW_EVENT.startTime);
  await page.locator('#f-endTime').fill(NEW_EVENT.endTime);
  await locationField(page, 0, 'venueName').fill(NEW_EVENT.venueName);
  await locationField(page, 0, 'city').fill(NEW_EVENT.city);
  await locationField(page, 0, 'country').selectOption(NEW_EVENT.country);
  await openSection(page, 'Price and RSVP');
  await page.locator('#f-capacity').fill(NEW_EVENT.capacity);
  // The status is first thing under Basics, in the Publishing box.
  await openSection(page, 'Basics');
  await expect(page.locator('#publishBox')).toHaveAttribute('data-status', 'draft');
  await expect(page.locator('#statusMeaning')).toHaveText(/^Only editors can see it/);
  await page.locator('#f-status').selectOption('published');
  await expect(page.locator('#publishBox')).toHaveAttribute('data-status', 'published');
  await expect(page.locator('#statusMeaning')).toHaveText(/^Live: anyone can find it/);
  await openSection(page, 'Attendees and notes');
  await page.locator('#f-staffNotes').fill(NEW_EVENT.staffNotes);
  await page.locator('#f-staffNotes').blur();
  // Both descriptions are needed: without the Chinese one, nothing is saved yet.
  await expect(status(page)).toHaveText(/^Saves by itself once it has a title/);
  await expect(page.locator('#editorView')).toBeHidden();
  // The pill names the field, and its tab is marked.
  await expect(status(page)).toHaveText(/^Saves by itself once it has a title/);
  await openSection(page, 'Basics');
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await expect(page.locator('#f-description')).toBeHidden();
  await page.locator('#f-descriptionZh').fill(NEW_EVENT.descriptionZh);
  await expect(page.locator('#descriptionSwitch [data-lang="zh"] .missing-mark')).toBeHidden();
  // Leaving the field creates the event.
  await page.locator('#f-descriptionZh').blur();

  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${NEW_EVENT.title}`);
  // The open event is kept in the address.
  await expect(page).toHaveURL(new RegExp(`/manage\\?slug=${NEW_EVENT.slug}$`));
  await expect(page.locator('#editorError')).toHaveText('');
  // The address was made from the title, and shows in the link field.
  await expect(page.locator('#editorView')).toHaveAttribute('href', `/e/${NEW_EVENT.slug}`);
  await expect(page.locator('#f-slug')).toHaveValue(NEW_EVENT.slug);
  await openSection(page, 'When and where');
  await expect(page.locator('#f-startDate')).toHaveValue(NEW_EVENT.startDate);
  await expect(page.locator('#f-startTime')).toHaveValue(NEW_EVENT.startTime);
  // An end time with no end date ends on the start date.
  await expect(page.locator('#f-endDate')).toHaveValue(NEW_EVENT.startDate);
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeesTitle')).toHaveText('0 people going');
  // The list, in its own tab, has the new event, under its status.
  await page.getByRole('tab', { name: 'Event list' }).click();
  await expect(page.locator('#listStatus').getByRole('button', { name: /^Published/ })).toHaveAttribute('aria-pressed', 'true');
  const newRow = list.locator('li', { hasText: NEW_EVENT.title });
  await expect(newRow.locator('.chip')).toHaveText('Published');
  await page.getByRole('tab', { name: 'Manage event' }).click();
  await expect(page.locator('#eventForm')).toBeVisible();

  // The section tab open stays open.
  await expect(page.locator('#epanel-people')).toBeVisible();

  // Edit. Each field saves as it is left; a new title keeps the address.
  await openSection(page, 'Basics');
  await page.locator('#f-title').fill(EDITED.title);
  await openSection(page, 'When and where');
  await locationField(page, 0, 'venueName').fill(EDITED.venueName);
  await locationField(page, 0, 'venueName').blur();
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${EDITED.title}`);
  await expect(page.locator('#editorView')).toHaveAttribute('href', `/e/${NEW_EVENT.slug}`);

  // Opened again from the list, the form holds the saved values.
  await page.locator('#editorClose').click();
  await expect(page.locator('#eventForm')).toBeHidden();
  await expect(page.locator('#listBox')).toBeVisible();
  await expect(list.locator('.item-title', { hasText: EDITED.title })).toHaveCount(1);
  await page.getByRole('button', { name: `Edit ${EDITED.title}` }).click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${EDITED.title}`);
  await expect(locationField(page, 0, 'venueName')).toHaveValue(EDITED.venueName);
  await expect(locationField(page, 0, 'country')).toHaveValue(NEW_EVENT.country);
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#f-staffNotes')).toHaveValue(NEW_EVENT.staffNotes);
  await openSection(page, 'Price and RSVP');
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
  await openSection(page, 'When and where');
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
  // A pick from a list saves at once.
  await openSection(page, 'Basics');
  await page.locator('#f-status').selectOption('published');
  await expect(status(page)).toHaveText(SAVED);

  // The times come back blank, as they were left.
  await openSection(page, 'When and where');
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
  // The new events are drafts, listed under Drafts with the seeded one.
  const seeded = Object.values(EVENTS).filter((event) => event.status === 'draft').length;
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
  // Published has too few for a second page; Drafts has two.
  await expect(page.locator('#listPager')).toBeHidden();
  await page.locator('#listStatus').getByRole('button', { name: /^Drafts/ }).click();

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

test('a change saves itself when its field is left, and a refused one says why', async ({ page }) => {
  const event = EVENTS.furmeet;
  await openManage(page);
  await page.getByRole('button', { name: `Edit ${event.title}` }).click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  await expect(status(page)).toHaveText(SAVED);

  // Typing alone saves nothing; leaving the field does. This event was
  // written before Chinese descriptions were needed, so it says that first.
  const summary = 'A walk along the bay, then dinner and dessert.';
  await page.locator('#f-summary').fill(summary);
  await expect(status(page)).toHaveText(SAVED);
  await page.locator('#f-title').click();
  await expect(status(page)).toHaveText('Not saved: Check this field: Description (Chinese).');
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await page.locator('#f-descriptionZh').fill('在喷泉集合。');
  await page.locator('#f-title').click();
  await expect(status(page)).toHaveText(SAVED);
  // A box ticked saves at once.
  await openSection(page, 'Price and RSVP');
  await page.locator('#f-priceHidden').check();
  await expect(status(page)).toHaveText(SAVED);

  // A blank title is refused, with the reason, and kept in the form; the
  // Basics tab is marked, and the mark goes once it is put right.
  await openSection(page, 'Basics');
  await page.locator('#f-title').fill('');
  await page.locator('#f-summary').click();
  await expect(status(page)).toHaveText('Not saved: Check this field: Title.');
  await expect(page.locator('#etab-basics .tab-mark')).toBeVisible();
  await expect(page.locator('#etab-price .tab-mark')).toBeHidden();
  await expect(page.locator('#f-title')).toHaveValue('');
  // Put right, it saves.
  await page.locator('#f-title').fill(event.title);
  await page.locator('#f-summary').click();
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#etab-basics .tab-mark')).toBeHidden();

  // A reload opens the same event, from the address, with the saved values.
  await page.reload();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  await expect(page.locator('#f-summary')).toHaveValue(summary);
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#f-priceHidden')).toBeChecked();

  // Closed, the Manage event tab says nothing is open.
  await page.locator('#editorClose').click();
  await expect(page).toHaveURL(/\/manage$/);
  await page.getByRole('tab', { name: 'Manage event' }).click();
  await expect(page.locator('#editorEmpty')).toBeVisible();
  await expect(page.locator('#eventForm')).toBeHidden();
  await page.locator('#editorEmptyNew').click();
  await expect(page.locator('#editorTitle')).toHaveText('New event');
});

test('the organiser is one of GFTV\'s teams, or anyone else typed in under Other', async ({ page }) => {
  const event = EVENTS.furmeet;
  await openManage(page);
  await page.getByRole('button', { name: `Edit ${event.title}` }).click();
  await expect(status(page)).toHaveText(SAVED);
  const pick = page.locator('#organiserPick');
  const other = page.locator('#f-organiserName');
  // A name that is not a team opens on Other, typed in.
  await expect(pick).toHaveValue('other');
  await expect(other).toHaveValue('SG Furmeets');
  await expect(pick.locator('option')).toHaveText([
    'Not set',
    'Community Inclusion and Integration Sub-Committee (CIISC)',
    'Community Initiative and Outreach (CIO) Division',
    'Core Coverage Support (CCS) Team',
    'Media and News (MAWS) Division',
    'Policy, Action and Leadership (PAL) Division',
    'Project Starlight Organising Sub-Committee (PSOSC)',
    'Technology and Infrastructure Development Sub-Committee (TIDSC)',
    'Other (type a name)',
  ]);
  // (This event was written before Chinese descriptions were needed.)
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await page.locator('#f-descriptionZh').fill('在喷泉集合。');
  await page.locator('#f-title').click();
  await expect(status(page)).toHaveText(SAVED);
  // A team: saved at once, by its full name; the box goes.
  await pick.selectOption('maws');
  await expect(other).toBeHidden();
  await expect(status(page)).toHaveText(SAVED);
  await page.reload();
  await expect(pick).toHaveValue('maws');
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventOrganiser')).toHaveText('Organised by Media and News (MAWS) Division');

  // Other: an empty box to type anyone's name in, saved once left.
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(status(page)).toHaveText(SAVED);
  await pick.selectOption('other');
  await expect(other).toBeVisible();
  await expect(other).toHaveValue('');
  await expect(other).toBeFocused();
  await other.fill('Paws Malaysia');
  await page.locator('#f-summary').click();
  await expect(status(page)).toHaveText(SAVED);
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventOrganiser')).toHaveText('Organised by Paws Malaysia');
});

test('the event list, the edit form and the staff tools are tabs, and the open tab is kept out of the address', async ({ page }) => {
  // (An editor has just Event list and Manage event: the venue sign-ups tab
  // went in migrations/027. event-editors.spec.js checks the staff tabs
  // stay hidden for them.)
  await openManage(page, ADMIN.username);
  const tabs = page.locator('#manageTabs');
  await expect(tabs.getByRole('tab')).toHaveText(['Event list', 'Manage event', 'ID reviews', 'Name filter', 'Password resets']);
  await expect(page.locator('#filterBox')).toBeHidden();
  await expect(page.locator('#editorEmpty')).toBeHidden();

  await tabs.getByRole('tab', { name: 'Name filter' }).click();
  await expect(page.locator('#filterBox')).toBeVisible();
  await expect(page.locator('#listBox')).toBeHidden();
  // The tab is kept out of the address bar, and a reload opens it again
  // once the staff tools' tabs have loaded.
  await expect(page).toHaveURL(/\/manage$/);
  await page.reload();
  await expect(page.locator('#filterBox')).toBeVisible();
  await expect(page.locator('#listBox')).toBeHidden();
  await tabs.getByRole('tab', { name: 'Name filter' }).click();

  // The arrow keys move between the tabs. With no event open, the edit tab
  // says so.
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'ID reviews' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#idReviewsBox')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Manage event' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#editorEmpty')).toBeVisible();
  await expect(page.locator('#listBox')).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Event list' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#listBox')).toBeVisible();

  // Opened again at #filter, that tab opens, and the address loses the hash.
  await page.goto('/manage#filter');
  await expect(page.locator('#filterBox')).toBeVisible();
  await expect(page).toHaveURL(/\/manage$/);
  // New event opens the edit tab.
  await page.locator('#newEvent').click();
  await expect(page.locator('#eventForm')).toBeVisible();
  await expect(page.locator('#filterBox')).toBeHidden();
});

test('an admin asked to delete an event can set it to Cancelled instead', async ({ page }) => {
  const event = EVENTS.convention;
  await openManage(page, ADMIN.username);
  await page.getByRole('button', { name: `Edit ${event.title}` }).click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  await expect(status(page)).toHaveText(SAVED);

  await page.locator('#editorDelete').click();
  const dialog = page.locator('#deleteModal');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Set to Cancelled instead' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();
  // Going back changes nothing.
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(dialog).toBeHidden();

  await page.locator('#editorDelete').click();
  await dialog.getByRole('button', { name: 'Set to Cancelled instead' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#manageNotice')).toHaveText('The event is now cancelled.');
  await expect(page.locator('#epanel-basics')).toBeVisible();
  await expect(page.locator('#f-status')).toHaveValue('cancelled');
  await expect(page.locator('#publishBox')).toHaveAttribute('data-status', 'cancelled');
  await expect(status(page)).toHaveText(SAVED);
  // Still there, and offered no second time.
  await page.locator('#editorDelete').click();
  await expect(dialog.getByRole('button', { name: 'Set to Cancelled instead' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Go back' }).click();

  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#eventView')).toBeVisible();
  await expect(page.locator('#eventChips')).toContainText('Cancelled');

  // The home feed's card shows it too, right after the kind.
  await page.goto('/');
  const card = page.locator('#feed a.event-card', { hasText: event.title });
  await expect(card.locator('.chip')).toHaveText(['Convention', 'Cancelled']);
  await expect(card.locator('.chip-danger')).toHaveText('Cancelled');
});

test('once Google Maps fills in a location, the editor can copy its street or full address', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The link lookup, answered here (the e2e server reaches no other site).
  await page.route('**/api/manage/place', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ place: {
      venueName: 'Suntec Convention Centre',
      venueAddress: '1 Raffles Blvd, Singapore 039593',
      city: 'Singapore',
      country: 'SG',
      mapsUrl: 'https://maps.app.goo.gl/suntec',
    } }),
  }));
  await openManage(page);
  await page.locator('#newEvent').click();
  await openSection(page, 'When and where');
  const card = page.locator('#locationList .location-card').first();
  const copyAddress = card.getByRole('button', { name: 'Copy address' });
  const copyFull = card.getByRole('button', { name: 'Copy full address' });

  // Typed in by hand: no copy buttons.
  await locationField(page, 0, 'venueAddress').fill('somewhere');
  await expect(copyAddress).toBeHidden();

  await locationField(page, 0, 'mapsUrl').fill('https://maps.app.goo.gl/suntec');
  await card.locator('.location-fill').click();
  await expect(locationField(page, 0, 'venueAddress')).toHaveValue('1 Raffles Blvd, Singapore 039593');
  await expect(copyAddress).toBeVisible();
  await expect(copyFull).toBeVisible();

  await copyAddress.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('1 Raffles Blvd, Singapore 039593');
  // The city is already in the street address, so it is not said twice.
  await copyFull.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Suntec Convention Centre, 1 Raffles Blvd, Singapore 039593');

  // No street address, nothing to copy.
  await locationField(page, 0, 'venueAddress').fill('');
  await expect(copyAddress).toBeHidden();
});
