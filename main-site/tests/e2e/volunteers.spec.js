// Volunteers at conventions (migrations/012): an editor switches volunteers
// on for a convention, signs up to volunteer from its page, ticks
// "Volunteered" in the attendee list, then makes next year's convention give
// last year's volunteers 15% off, which the event page tells them.

import { test, expect, serverOrigin, signInAsStaff, openSection } from './fixtures.js';
import { EVENTS, STAFF } from './seed.js';

const convention = EVENTS.convention;
const NEXT = { title: 'Lion City Furcon 2033', slug: 'lion-city-furcon-2033', startDate: '2033-08-01' };

test('a convention takes volunteers, an editor confirms them, and the next convention gives them a benefit', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  const status = page.locator('#autosaveStatus');

  // A furmeet has no volunteer settings.
  await page.goto(`/manage?slug=${EVENTS.furmeet.slug}#editor`);
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#volunteersConventionOnly')).toBeVisible();
  await expect(page.locator('#volunteerFields')).toBeHidden();

  // The convention: volunteers on. It is the only convention, so there is
  // no earlier one to give a benefit for yet.
  await page.goto(`/manage?slug=${convention.slug}#editor`);
  await expect(status).toHaveText('All changes saved');
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#volunteersConventionOnly')).toBeHidden();
  await expect(page.locator('#f-volunteerDiscountFrom')).toBeDisabled();
  await page.locator('#f-volunteersWanted').check();
  await expect(status).toHaveText('All changes saved');
  await page.locator('#f-volunteerDiscountEnabled').check();
  await expect(status).toHaveText('All changes saved');
  await expect(page.locator('#f-volunteerDiscountFrom')).toBeEnabled();
  await expect(page.locator('#volunteerSourcesNone')).toBeVisible();
  await expect(page.locator('#f-volunteerDiscountFrom option')).toHaveText(['Pick a convention']);
  await page.locator('#f-volunteerDiscountEnabled').uncheck();
  await expect(status).toHaveText('All changes saved');

  // Signing up to volunteer with the RSVP.
  await page.goto(`/e/${convention.slug}`);
  await expect(page.locator('#factVolunteers')).toHaveText('This convention is taking volunteers. Tick "I would like to volunteer" when you RSVP.');
  const volunteer = page.getByLabel('I would like to volunteer at this convention');
  await volunteer.check();
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpStatus')).toHaveText('You are going');
  await page.reload();
  await expect(volunteer).toBeChecked();
  await expect(page.locator('#rsvpVolunteerNote')).toBeHidden();

  // The attendee list says who signed up; the editor ticks who volunteered.
  await page.goto(`/manage?slug=${convention.slug}#editor`);
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeeList')).toContainText('Signed up to volunteer');
  await expect(page.locator('#attendeeList .item-row').first()).toContainText('#1 · inkfox');
  await expect(page.locator('#attendeesVolunteers')).toHaveText('Volunteers: 1 signed up');
  await page.getByRole('checkbox', { name: `${STAFF.displayName} volunteered at this convention` }).check();
  await expect(page.locator('#attendeesVolunteers')).toHaveText('Volunteers: 1 signed up · 1 volunteered');
  await expect(status).toHaveText('All changes saved');
  await page.reload();
  await openSection(page, 'Attendees and notes');
  await expect(page.getByRole('checkbox', { name: `${STAFF.displayName} volunteered at this convention` })).toBeChecked();

  // On its page, thanks.
  await page.goto(`/e/${convention.slug}`);
  await expect(page.locator('#rsvpVolunteerNote')).toHaveText('Thank you for volunteering at this convention.');

  // Next year's convention gives this year's volunteers 15% off.
  await page.goto('/manage');
  await page.locator('#newEvent').click();
  await page.locator('#f-title').fill(NEXT.title);
  await page.locator('#f-kind').selectOption('convention');
  await page.locator('#f-description').fill('The next one.');
  await page.locator('#descriptionSwitch').getByRole('button', { name: '中文' }).click();
  await page.locator('#f-descriptionZh').fill('下一届。');
  await openSection(page, 'When and where');
  await page.locator('#f-startDate').fill(NEXT.startDate);
  await page.locator('#f-startDate').blur();
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${NEXT.title}`);
  await openSection(page, 'Basics');
  await page.locator('#f-status').selectOption('published');
  await expect(status).toHaveText('All changes saved');
  await openSection(page, 'Price and RSVP');
  await page.locator('#f-volunteerDiscountEnabled').check();
  await expect(page.locator('#volunteerSourcesNone')).toBeHidden();
  await page.locator('#f-volunteerDiscountFrom').selectOption(convention.id);
  await expect(page.locator('#f-volunteerDiscountType')).toHaveValue('percent');
  await page.locator('#f-volunteerDiscountValue').fill('15');
  await page.locator('#f-volunteerDiscountValue').blur();
  await expect(status).toHaveText('All changes saved');

  await page.goto(`/e/${NEXT.slug}`);
  await expect(page.locator('#factVolunteers')).toHaveText(`Volunteered at ${convention.title}? You get 15% off.`);
  await expect(page.locator('#rsvpVolunteerNote')).toHaveText(`You volunteered at ${convention.title}, so you get 15% off here.`);
  // This one is not taking volunteers itself.
  await expect(page.locator('#rsvpVolunteerRow')).toBeHidden();

  // Signed out: the benefit is there for everyone to read, but nobody's own.
  await page.context().clearCookies();
  await page.reload();
  await expect(page.locator('#factVolunteers')).toHaveText(`Volunteered at ${convention.title}? You get 15% off.`);
  await expect(page.locator('#rsvpVolunteerNote')).toBeHidden();
});
