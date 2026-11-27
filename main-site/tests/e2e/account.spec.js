// The account page of a public account with 2FA: the profile, then its tabs
// (the events it is going to, notifications, Security with each passkey's
// "Last used" line (help desk #18, job 01), and Profile, with the country
// of origin).

import { test, expect, serverOrigin, signInWithBackupCode, signInAsStaff } from './fixtures.js';
import { EVENTS, PASSKEY_MEMBER, PASSKEYS, BACKUP_CODES, STAFF } from './seed.js';

test('the account page shows the profile, RSVPs, and when each passkey was last used', async ({ page }) => {
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);
  await expect(page.locator('#accountView')).toBeVisible();
  await expect(page.locator('#accountLoading')).toBeHidden();

  // Who you are, above the tabs.
  await expect(page.locator('#displayName')).toHaveText(PASSKEY_MEMBER.displayName);
  await expect(page.locator('#username')).toHaveText(PASSKEY_MEMBER.username);
  await expect(page.locator('#role')).toHaveText('Member');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['My events', 'Notifications', 'Security', /^Profile/], { useInnerText: true });
  // No country of origin yet (an account from before migrations/015): the
  // Profile tab is marked.
  await expect(page.locator('#profileMark')).toBeVisible();

  // The events you are going to, in the first tab; the others are hidden.
  await expect(page.getByRole('tab', { name: 'My events' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-security')).toBeHidden();
  await expect(page.locator('#rsvpUpcoming .event-card-title')).toHaveText([EVENTS.furmeet.title]);
  await expect(page.locator('#rsvpEmpty')).toBeHidden();

  // Notifications: the stored choices, and push offered on this device.
  await page.getByRole('tab', { name: 'Notifications' }).click();
  // The address bar keeps no #tab on this page.
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator('#panel-going')).toBeHidden();
  await expect(page.locator('#prefUpdates')).toBeChecked();
  // Reminders: a day before to start with; more than one time can be picked,
  // each saving at once, and kept.
  const remind = (name) => page.locator('#prefReminders').getByLabel(name);
  await expect(remind('1 day before')).toBeChecked();
  for (const name of ['1 hour before', '2 hours before', '3 hours before', '1 week before']) {
    await expect(remind(name)).not.toBeChecked();
  }
  let saved = page.waitForResponse('**/api/me/notifications');
  await remind('1 hour before').check();
  await saved;
  saved = page.waitForResponse('**/api/me/notifications');
  await remind('1 week before').check();
  await saved;
  await page.reload();
  await page.getByRole('tab', { name: 'Notifications' }).click();
  for (const name of ['1 hour before', '1 day before', '1 week before']) {
    await expect(remind(name)).toBeChecked();
  }
  await expect(remind('2 hours before')).not.toBeChecked();
  await expect(page.locator('#prefNewEvents')).not.toBeChecked();
  await expect(page.locator('#pushState')).toHaveText('Notifications are off for this device.');
  await expect(page.locator('#pushOn')).toBeVisible();
  await expect(page.locator('#notifyTelegramBox')).toBeHidden();

  // Security.
  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.locator('#securityLede')).toHaveText('A second step is optional for your account, but it keeps it safe if your password leaks.');
  await expect(page.locator('#totpState')).toHaveText('Not set up.');
  const passkeys = page.locator('#passkeyList li');
  await expect(passkeys).toHaveCount(2);
  await expect(passkeys.nth(0).locator('.item-main > span')).toHaveText([
    PASSKEYS.used.label,
    /^Added Sep 1, 2026, 11:00\sAM$/,
    /^Last used Nov 10, 2026, 2:30\sPM$/,
  ]);
  await expect(passkeys.nth(1).locator('.item-main > span')).toHaveText([
    PASSKEYS.unused.label,
    /^Added Oct 5, 2026, 8:15\sPM$/,
    'Never used',
  ]);
  await expect(passkeys.nth(0).getByRole('button', { name: `Remove passkey ${PASSKEYS.used.label}` })).toBeVisible();
  // One of the ten backup codes went on signing in.
  await expect(page.locator('#backupState')).toHaveText('9 unused backup codes from this site.');
  await expect(page.locator('#telegramBox')).toBeHidden();

  // Public accounts can rename themselves and delete the account, in Profile.
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.locator('#nameInput')).toHaveValue(PASSKEY_MEMBER.displayName);
  await expect(page.locator('#deleteBox')).toBeVisible();

  // The country of origin: Singapore, Malaysia and Indonesia first.
  await expect(page.locator('#countryMissing')).toBeVisible();
  const countries = page.locator('#countryInput option');
  await expect(countries.nth(1)).toHaveText('Singapore');
  await expect(countries.nth(2)).toHaveText('Malaysia');
  await expect(countries.nth(3)).toHaveText('Indonesia');
  await page.locator('#countryInput').selectOption('MY');
  await page.locator('#countrySubmit').click();
  await expect(page.locator('#accountNotice')).toHaveText('Personal details saved.');
  await expect(page.locator('#countryMissing')).toBeHidden();
  await expect(page.locator('#profileMark')).toBeHidden();
  // Set once, then locked (migrations/024); the emergency contact stays open.
  await expect(page.locator('#countryInput')).toBeDisabled();
  await expect(page.locator('#personalLocked')).toBeVisible();
  await page.locator('#legalNameInput').fill('Otter Tan');
  await page.locator('#emergencyNameInput').fill('Ma Tan');
  await page.locator('#emergencyPhoneInput').fill('+65 9123 4567');
  await page.locator('#countrySubmit').click();
  await expect(page.locator('#legalNameInput')).toBeDisabled();
  await expect(page.locator('#legalNameInput')).toHaveValue('Otter Tan');
  await expect(page.locator('#emergencyNameInput')).toBeEnabled();

  // A reload opens the same tab, from the address.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#nameInput')).toBeVisible();
});

test('a staff account sets only its country in Profile: its name comes from gftv.asia', async ({ page }) => {
  await page.goto('/login?next=/account');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/account`);
  await page.goto('/account#profile');
  await expect(page.getByRole('tab', { name: /^Profile/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#nameBox')).toBeHidden();
  await expect(page.locator('#deleteBox')).toBeHidden();
  await page.locator('#countryInput').selectOption('SG');
  await page.locator('#countrySubmit').click();
  await expect(page.locator('#accountNotice')).toHaveText('Personal details saved.');
});
