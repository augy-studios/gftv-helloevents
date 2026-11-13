// Manage, for a staff editor: sign in with the authenticator app, create an
// event, edit it, and see the change on the public page and in the feed.

import { test, expect, serverOrigin, signInAsStaff } from './fixtures.js';
import { EVENTS, STAFF } from './seed.js';

const NEW_EVENT = {
  title: 'Riverside Sketch Meet',
  slug: 'riverside-sketch-meet',
  summary: 'Bring a sketchbook; we draw the river and each other.',
  description: 'Pencils provided. We move indoors if it rains.',
  startsLocal: '2032-05-02T15:00',
  endsLocal: '2032-05-02T17:00',
  venueName: 'Riverside Point',
  city: 'Singapore',
  country: 'Singapore',
  capacity: '15',
  staffNotes: 'Bring spare easels.',
};

const EDITED = {
  title: 'Riverside Sketch and Paint Meet',
  venueName: 'Clarke Quay Central',
};

test('an editor creates an event in Manage, edits it, and the public page and feed show the change', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);

  // Every event, drafts included, for editors.
  const list = page.locator('#eventList');
  await expect(page.locator('#listBox')).toHaveAttribute('aria-busy', 'false');
  for (const event of Object.values(EVENTS)) {
    await expect(list.locator('.item-title', { hasText: event.title })).toHaveCount(1);
  }
  const draftRow = list.locator('li', { hasText: EVENTS.draft.title });
  await expect(draftRow.locator('.chip')).toHaveText('Draft');
  await expect(page.locator('header [data-when="manager"]')).toBeVisible();

  // Create.
  await page.locator('#newEvent').click();
  await expect(page.locator('#editorTitle')).toHaveText('New event');
  await expect(page.locator('#f-timezone')).toHaveValue('Asia/Singapore');
  await page.locator('#f-title').fill(NEW_EVENT.title);
  await page.locator('#f-summary').fill(NEW_EVENT.summary);
  await page.locator('#f-description').fill(NEW_EVENT.description);
  await page.locator('#f-startsLocal').fill(NEW_EVENT.startsLocal);
  await page.locator('#f-endsLocal').fill(NEW_EVENT.endsLocal);
  await page.locator('#f-venueName').fill(NEW_EVENT.venueName);
  await page.locator('#f-city').fill(NEW_EVENT.city);
  await page.locator('#f-country').fill(NEW_EVENT.country);
  await page.locator('#f-capacity').fill(NEW_EVENT.capacity);
  await page.locator('#f-status').selectOption('published');
  await page.locator('#f-staffNotes').fill(NEW_EVENT.staffNotes);
  await page.locator('#editorSave').click();

  await expect(page.locator('#manageNotice')).toHaveText('Saved.');
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${NEW_EVENT.title}`);
  await expect(page.locator('#editorError')).toHaveText('');
  // The slug was made from the title.
  await expect(page.locator('#f-slug')).toHaveValue(NEW_EVENT.slug);
  await expect(page.locator('#f-startsLocal')).toHaveValue(NEW_EVENT.startsLocal);
  await expect(page.locator('#attendeesTitle')).toHaveText('0 people going');
  const newRow = list.locator('li', { hasText: NEW_EVENT.title });
  await expect(newRow.locator('.chip')).toHaveText('Published');

  // Edit.
  await page.locator('#f-title').fill(EDITED.title);
  await page.locator('#f-venueName').fill(EDITED.venueName);
  await page.locator('#editorSave').click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${EDITED.title}`);
  await expect(list.locator('.item-title', { hasText: EDITED.title })).toHaveCount(1);
  await expect(page.locator('#f-slug')).toHaveValue(NEW_EVENT.slug);

  // Opened again from the list, the form holds the saved values.
  await page.locator('#editorClose').click();
  await expect(page.locator('#eventForm')).toBeHidden();
  await page.getByRole('button', { name: `Edit ${EDITED.title}` }).click();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${EDITED.title}`);
  await expect(page.locator('#f-venueName')).toHaveValue(EDITED.venueName);
  await expect(page.locator('#f-staffNotes')).toHaveValue(NEW_EVENT.staffNotes);
  await expect(page.locator('#f-capacity')).toHaveValue(NEW_EVENT.capacity);

  // The public page has the change, and not the staff notes.
  await page.goto(`/e/${NEW_EVENT.slug}`);
  await expect(page.locator('#eventView')).toBeVisible();
  await expect(page.locator('#eventTitle')).toHaveText(EDITED.title);
  await expect(page.locator('#eventSummary')).toHaveText(NEW_EVENT.summary);
  await expect(page.locator('#factWhen')).toHaveText(/^Sun, May 2, 2032, 3:00\sPM to 5:00\sPM GMT\+8$/);
  await expect(page.locator('#factWhere')).toHaveText(`${EDITED.venueName}, Singapore, Singapore`);
  await expect(page.locator('#factGoing')).toHaveText('0 of 15 spaces taken');
  await expect(page.locator('#manageLink')).toHaveAttribute('href', `/manage?slug=${NEW_EVENT.slug}`);
  await expect(page.getByText(NEW_EVENT.staffNotes)).toHaveCount(0);

  // And it takes its place in the feed by date.
  await page.goto('/');
  await expect(page.locator('#feed .event-card-title')).toHaveText([EVENTS.furmeet.title, EDITED.title, EVENTS.convention.title]);
});
