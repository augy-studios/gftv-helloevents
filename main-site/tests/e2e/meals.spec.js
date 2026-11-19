// Coming just for a meal: a member picks the meals instead of the whole
// event and changes their mind while going; an editor changes which meals
// are offered and sees who is coming for which.

import { test, expect, serverOrigin, enterPassword, signInAsStaff } from './fixtures.js';
import { EVENTS, MEMBER, STAFF } from './seed.js';

const event = EVENTS.convention;

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
  await expect(page.locator('#f-meal-breakfast')).not.toBeChecked();
  await expect(page.locator('#f-meal-lunch')).toBeChecked();
  await expect(page.locator('#f-meal-dinner')).toBeChecked();
  await expect(page.locator('#mealCustomList input[data-meal-id]')).toHaveValue('High tea');
  await expect(page.locator('#attendeesMeals')).toHaveText('Just for a meal: Dinner 1');
  await expect(page.locator('#attendeeList')).toContainText('Just for: Dinner');

  // Breakfast on, lunch off: each saves as it is ticked.
  await page.locator('#f-meal-breakfast').check();
  await expect(status).toHaveText('All changes saved');
  await page.locator('#f-meal-lunch').uncheck();
  await expect(status).toHaveText('All changes saved');
  // A renamed meal saves when its field is left; a new one too.
  await page.locator('#mealCustomList input[data-meal-id]').fill('Afternoon tea');
  await page.locator('#mealAdd').click();
  await page.locator('#mealCustomList input[data-meal-id]').nth(1).fill('Supper');
  await page.locator('#f-staffNotes').click();
  await expect(status).toHaveText('All changes saved');
  // The second one's Remove button saves at once.
  await page.getByRole('button', { name: 'Remove meal 2' }).click();
  await expect(status).toHaveText('All changes saved');
  // Lunch is off, so its places are too; dinner gets one place.
  await expect(page.locator('#f-meal-lunch-limit')).toBeDisabled();
  await page.getByLabel('Places for Dinner (blank for no limit)').fill('1');
  await page.locator('#f-staffNotes').click();
  await expect(status).toHaveText('All changes saved');
  await expect(page.locator('#attendeesMeals')).toHaveText('Just for a meal: Dinner 1 of 1');

  await page.reload();
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
