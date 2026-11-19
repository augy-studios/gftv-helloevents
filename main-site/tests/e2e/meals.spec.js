// Coming just for a meal: a member picks the meals instead of the whole
// event and changes their mind while going; an editor changes which meals
// are offered and sees who is coming for which.

import { test, expect, serverOrigin, enterPassword, signInAsStaff, openSection } from './fixtures.js';
import { EVENTS, MEMBER, STAFF } from './seed.js';

const event = EVENTS.convention;
// Leaves the field being typed in (focus moves to the form's title), which
// saves it.
const leaveField = (page) => page.locator('#editorTitle').click();

test('a member RSVPs only for lunch, adds high tea, then comes to the whole event', async ({ page }) => {
  await page.goto(`/e/${event.slug}`);
  // Everyone sees which meals can be come to on their own.
  await expect(page.locator('#factMeals')).toHaveText('Lunch, Dinner, High tea');
  await expect(page.locator('#rsvpMeals')).toBeHidden();

  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);

  const button = page.locator('#rsvpBtn');
  const status = page.locator('#rsvpStatus');
  const meals = page.locator('#rsvpMeals');
  await expect(meals).toBeVisible();
  await expect(page.getByLabel('The whole event')).toBeChecked();
  await expect(page.locator('#rsvpMealList')).toBeHidden();

  // Only the meal: one must be ticked before the button works.
  await page.getByLabel('I only want to show up for the meal').check();
  await expect(page.locator('#rsvpMealList')).toBeVisible();
  await expect(page.locator('#rsvpMealsHint')).toBeVisible();
  await expect(button).toBeDisabled();
  await page.getByLabel('Lunch').check();
  await expect(page.locator('#rsvpMealsHint')).toBeHidden();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(status).toHaveText('You are going, just for: Lunch');
  // Coming just for a meal takes none of the event's spaces.
  await expect(page.locator('#factGoing')).toHaveText('0 going');

  // While going, a change saves itself, and is kept on the server.
  await page.getByLabel('High tea').check();
  await expect(status).toHaveText('You are going, just for: Lunch, High tea');
  await page.reload();
  await expect(status).toHaveText('You are going, just for: Lunch, High tea');
  await expect(page.getByLabel('I only want to show up for the meal')).toBeChecked();
  await expect(page.getByLabel('Lunch')).toBeChecked();
  await expect(page.getByLabel('Dinner')).not.toBeChecked();

  await page.getByLabel('The whole event').check();
  await expect(status).toHaveText('You are going');
  await expect(page.locator('#factGoing')).toHaveText('1 going');
  await page.reload();
  await expect(status).toHaveText('You are going');
  await expect(page.getByLabel('The whole event')).toBeChecked();

  await button.click();
  await expect(status).toBeHidden();
  await expect(page.locator('#factGoing')).toHaveText('0 going');
});

test('an editor changes the meals offered and sees who is coming for which', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);

  // The editor says they are coming just for dinner, from the event page.
  await page.goto(`/e/${event.slug}`);
  await page.getByLabel('I only want to show up for the meal').check();
  await page.getByLabel('Dinner').check();
  await page.locator('#rsvpBtn').click();
  await expect(page.locator('#rsvpStatus')).toHaveText('You are going, just for: Dinner');

  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  const status = page.locator('#autosaveStatus');
  await expect(status).toHaveText('All changes saved');
  await openSection(page, 'Meals');
  await expect(page.locator('#f-meal-breakfast')).not.toBeChecked();
  await expect(page.locator('#f-meal-lunch')).toBeChecked();
  await expect(page.locator('#f-meal-dinner')).toBeChecked();
  await expect(page.locator('#mealCustomList input[data-meal-id]')).toHaveValue('High tea');
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeesMeals')).toHaveText('Just for a meal: Dinner 1');
  await expect(page.locator('#attendeeList')).toContainText('Just for: Dinner');
  await openSection(page, 'Meals');

  // Breakfast on, lunch off: each saves as it is ticked.
  await page.locator('#f-meal-breakfast').check();
  await expect(status).toHaveText('All changes saved');
  await page.locator('#f-meal-lunch').uncheck();
  await expect(status).toHaveText('All changes saved');
  // A renamed meal saves when its field is left; a new one too.
  await page.locator('#mealCustomList input[data-meal-id]').fill('Afternoon tea');
  await page.locator('#mealAdd').click();
  await page.locator('#mealCustomList input[data-meal-id]').nth(1).fill('Supper');
  await leaveField(page);
  await expect(status).toHaveText('All changes saved');
  // The second one's Remove button saves at once.
  await page.getByRole('button', { name: 'Remove meal 2' }).click();
  await expect(status).toHaveText('All changes saved');
  // Lunch is off, so its places are too; dinner gets one place.
  await expect(page.locator('#f-meal-lunch-limit')).toBeDisabled();
  await page.getByLabel('Places for Dinner (blank for no limit)').fill('1');
  await leaveField(page);
  await expect(status).toHaveText('All changes saved');
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeesMeals')).toHaveText('Just for a meal: Dinner 1 of 1');

  await page.reload();
  // The section open before the reload is not kept: the form opens on Basics.
  await openSection(page, 'Meals');
  await expect(page.locator('#f-meal-breakfast')).toBeChecked();
  await expect(page.locator('#f-meal-lunch')).not.toBeChecked();
  await expect(page.locator('#mealCustomList input[data-meal-id]')).toHaveCount(1);
  await expect(page.locator('#mealCustomList input[data-meal-id]')).toHaveValue('Afternoon tea');

  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#factMeals')).toHaveText('Breakfast, Dinner (full), Afternoon tea');
  await expect(page.locator('#rsvpStatus')).toHaveText('You are going, just for: Dinner');
  // Dinner is full, but the editor already has a place at it.
  await expect(page.getByLabel('Dinner (full)')).toBeChecked();
  await expect(page.getByLabel('Dinner (full)')).toBeEnabled();
});

test('an editor holds dinner somewhere else, and the event page says where', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#editorTitle')).toHaveText(`Editing ${event.title}`);
  const status = page.locator('#autosaveStatus');
  await expect(status).toHaveText('All changes saved');
  await openSection(page, 'Meals');

  // Breakfast is not offered, so it has no "held somewhere else"; dinner does.
  await expect(page.getByLabel('Breakfast is held somewhere else')).toBeHidden();
  const dinnerAway = page.getByLabel('Dinner is held somewhere else');
  await expect(dinnerAway).not.toBeChecked();

  // Ticking it opens a first card, labelled as the meal's location.
  await dinnerAway.check();
  const dinnerPlace = page.locator('.meal-place').filter({ has: dinnerAway });
  const card = dinnerPlace.locator('.location-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.location-title')).toHaveText('Dinner: location 1');
  await expect(card.locator('[data-key="label"]')).toHaveValue('meal');
  await expect(card.locator('[data-key="mapsUrl"]')).toBeFocused();
  await card.locator('[data-key="venueName"]').fill('Lau Pa Sat');
  await card.locator('[data-key="venueAddress"]').fill('18 Raffles Quay');
  await leaveField(page);
  await expect(status).toHaveText('All changes saved');

  // A meeting point for dinner too.
  await dinnerPlace.getByRole('button', { name: 'Add a place' }).click();
  await expect(card).toHaveCount(2);
  await expect(card.nth(1).locator('[data-key="label"]')).toHaveValue('meeting');
  await card.nth(1).locator('[data-key="venueName"]').fill('Raffles Place MRT, Exit H');
  await leaveField(page);
  await expect(status).toHaveText('All changes saved');

  await page.reload();
  await openSection(page, 'Meals');
  await expect(page.getByLabel('Dinner is held somewhere else')).toBeChecked();
  await expect(page.getByLabel('Lunch is held somewhere else')).not.toBeChecked();
  await expect(card.nth(0).locator('[data-key="venueName"]')).toHaveValue('Lau Pa Sat');
  await expect(card.nth(1).locator('[data-key="venueName"]')).toHaveValue('Raffles Place MRT, Exit H');

  // The event page lists the event's own place, then dinner's.
  await page.goto(`/e/${event.slug}`);
  const where = page.locator('#factWhere');
  await expect(where).toContainText('Event location');
  await expect(where).toContainText('Suntec Convention Centre');
  await expect(where.locator('.location-heading')).toHaveText(['Event location', 'Dinner', 'Dinner · Meeting location']);
  await expect(where).toContainText('Lau Pa Sat');
  await expect(where).toContainText('18 Raffles Quay');
  await expect(where).toContainText('Raffles Place MRT, Exit H');

  // Unticked, dinner is back at the event, and its cards are not saved.
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(status).toHaveText('All changes saved');
  await openSection(page, 'Meals');
  await page.getByLabel('Dinner is held somewhere else').uncheck();
  await expect(card.first()).toBeHidden();
  await expect(status).toHaveText('All changes saved');
  await page.reload();
  await openSection(page, 'Meals');
  await expect(page.getByLabel('Dinner is held somewhere else')).not.toBeChecked();
  await expect(card).toHaveCount(0);
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#factWhere')).not.toContainText('Lau Pa Sat');
  await expect(page.locator('#factWhere .location-heading')).toHaveCount(0);
});
