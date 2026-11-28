// The page tours (js/tour.js, js/tours.js, docs/page-tour-spec.md): shown
// the first time a page or tab is opened, never again on their own once
// ended, adapting to what is on the page and to the role, and replayed by the
// header's ? button.

import { test, expect, serverOrigin, signInAsStaff, signInWithBackupCode } from './fixtures.js';
import { ADMIN, STAFF, PASSKEY_MEMBER, BACKUP_CODES } from './seed.js';

test.use({ toursSeen: false });

const tour = (page) => page.locator('.tour');
const text = (page) => page.locator('#tourText');
const next = (page) => page.locator('.tour-next');
const dots = (page) => page.locator('.tour-dots > span');
const seen = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tour.seen') || '[]'));

// Clicks Next until the tour's last step, then Done.
async function finish(page) {
  const count = await dots(page).count();
  for (let step = 1; step < count; step += 1) {
    await expect(next(page)).toHaveText('Next');
    await next(page).click();
  }
  await expect(next(page)).toHaveText('Done');
  await next(page).click();
  await expect(tour(page)).toHaveCount(0);
}

test('the feed shows its tour once, and the ? button replays it without the hint', async ({ page }) => {
  await page.goto('/');
  await expect(tour(page)).toBeVisible();
  await expect(page.locator('.tour')).toHaveAttribute('role', 'dialog');
  await expect(text(page)).toHaveText('Search by name, place or organiser, within the events picked below.');
  await expect(next(page)).toBeFocused();
  // Signed out: the sign-in link, not Account or Manage, and the ? hint last.
  // search, when, kind, the first card, sign in, the hint.
  await expect(dots(page)).toHaveCount(6);
  // The page under it can't be scrolled or reached.
  await expect(page.locator('html')).toHaveClass(/touring/);
  await expect(page.locator('main')).toHaveAttribute('inert', '');

  // The right arrow moves on, like Next.
  await page.keyboard.press('ArrowRight');
  await expect(text(page)).toHaveText('Upcoming events, ones whose dates are still to come, or past ones.');
  await next(page).click();
  await expect(text(page)).toHaveText('Narrow it down to furmeets, conventions or everything else.');
  await next(page).click();
  await expect(text(page)).toHaveText('Open an event for the details, who is going, and to RSVP.');
  await next(page).click();
  await expect(text(page)).toHaveText('Sign in to RSVP and get reminders before an event.');
  await next(page).click();
  await expect(text(page)).toHaveText('Tap ? on any page to see its tour again.');
  await expect(next(page)).toHaveText('Done');
  await next(page).click();

  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  expect(await seen(page)).toEqual(['home', 'hint']);

  // Not again on its own.
  await page.reload();
  await expect(page.locator('#feed')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#tourBtn')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(tour(page)).toHaveCount(0);

  // The ? button replays it, without the step about itself, and changes
  // nothing about what has been seen.
  await page.locator('#tourBtn').click();
  await expect(tour(page)).toBeVisible();
  await expect(dots(page)).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('#tourBtn')).toBeFocused();
  expect(await seen(page)).toEqual(['home', 'hint']);
});

test('the account page tour introduces the tabs, then each tab shows its own the first time', async ({ page }) => {
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);

  // The page's tour: sign out elsewhere, the four tabs, the hint.
  await expect(text(page)).toHaveText('Signed in on a shared or borrowed device? Sign out everywhere else from here.');
  await expect(dots(page)).toHaveCount(6);
  await finish(page);

  // The open tab's follows straight on.
  await expect(text(page)).toHaveText('Events you RSVP to show up here. Open one to change your meals or take your RSVP back.');
  await finish(page);

  // Security, the first time it is opened. Skip ends it, and it stays seen.
  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(tour(page)).toBeVisible();
  await expect(page.locator('.tour-skip')).toHaveText('Skip');
  await page.locator('.tour-skip').click();
  await expect(tour(page)).toHaveCount(0);
  expect(await seen(page)).toEqual(['account', 'hint', 'account.going', 'account.security']);

  await page.getByRole('tab', { name: 'My events' }).click();
  await page.getByRole('tab', { name: 'Security' }).click();
  await page.waitForTimeout(1500);
  await expect(tour(page)).toHaveCount(0);

  // The ? button on a tab: the page's tour (less the hint), then that tab's,
  // as one. Telegram is not set up on the e2e server, so Security's step
  // about it is left out: the authenticator, passkeys and backup codes.
  await page.locator('#tourBtn').click();
  await expect(dots(page)).toHaveCount(5 + 3);
  await page.keyboard.press('Escape');
});

test('the Manage tour covers the tabs each role has', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  // An editor: Event list, Manage event, New event, the hint.
  await expect(text(page)).toHaveText('Event list: every event, drafts and ones not released yet included.');
  await expect(dots(page)).toHaveCount(4);
  await finish(page);
  await expect(text(page)).toHaveText('Published, Drafts and Cancelled each have their own list. The number says how many.');
  await finish(page);

  // Opening an event: the form's tour, then its first section's.
  await page.locator('#eventList .item-row .btn').first().click();
  await expect(text(page)).toHaveText('The form comes in sections. A dot on a tab means a field there needs checking.');
  // An editor cannot delete, so that step is left out.
  await expect(dots(page)).toHaveCount(3);
  await finish(page);
  await expect(text(page)).toHaveText(/^Draft, Published or Cancelled/);
  await finish(page);
  expect(await seen(page)).toEqual(['manage', 'hint', 'manage.events', 'manage.editor', 'editor.basics']);
});

test('an admin is also shown the ID reviews, HelloID tuning, Name filter and Password resets tabs', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, ADMIN.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await expect(text(page)).toHaveText('Event list: every event, drafts and ones not released yet included.');
  await expect(dots(page)).toHaveCount(8);
  await page.keyboard.press('Escape');
  // Skip quiets the rest until another tab opens.
  await page.waitForTimeout(1500);
  await expect(tour(page)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Password resets' }).click();
  await expect(text(page)).toHaveText('Check it is really them before making a code: whoever has it can set a new password.');
});

test('someone who has seen every older tour is still shown the new personal details tour once', async ({ page }) => {
  // Every tour from before registration forms (migrations/024) already seen.
  await page.addInitScript(() => {
    const older = ['home', 'event', 'checkout', 'checkout.pay', 'account', 'account.going', 'account.notifications', 'account.security', 'account.profile', 'hint'];
    if (!localStorage.getItem('tour.seen')) {
      localStorage.setItem('tour.seen', JSON.stringify(older));
    }
  });
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);
  await page.getByRole('tab', { name: /^Profile/ }).click();
  await expect(text(page)).toHaveText('Your legal name and date of birth, for events whose registration form asks. You fill them in once, here.');
  await expect(dots(page)).toHaveCount(3);
  await finish(page);
  expect(await seen(page)).toContain('account.personal');
  // Then ID verification (and sticker packs, where the site has them), new
  // to them too.
  await expect(text(page)).toHaveText("Some events ask you to verify your ID before you RSVP. Verify once here, with HelloID (GFTV's own, and free) or another way, and it counts for every event that accepts that way.");
  await finish(page);
  expect(await seen(page)).toContain('account.profile-extras');
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(tour(page)).toHaveCount(0);
});
