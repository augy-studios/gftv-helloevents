// The account page of a public account with 2FA: the profile, the events
// it is going to, notifications, and the Security section, including each
// passkey's "Last used" line (help desk #18, job 01).

import { test, expect, serverOrigin, signInWithBackupCode } from './fixtures.js';
import { EVENTS, PASSKEY_MEMBER, PASSKEYS, BACKUP_CODES } from './seed.js';

test('the account page shows the profile, RSVPs, and when each passkey was last used', async ({ page }) => {
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);
  await expect(page.locator('#accountView')).toBeVisible();
  await expect(page.locator('#accountLoading')).toBeHidden();

  // Who you are. Public accounts can rename themselves and delete the account.
  await expect(page.locator('#displayName')).toHaveText(PASSKEY_MEMBER.displayName);
  await expect(page.locator('#username')).toHaveText(PASSKEY_MEMBER.username);
  await expect(page.locator('#role')).toHaveText('Member');
  await expect(page.locator('#nameInput')).toHaveValue(PASSKEY_MEMBER.displayName);
  await expect(page.locator('#deleteBox')).toBeVisible();

  // The events you are going to.
  await expect(page.locator('#rsvpUpcoming .event-card-title')).toHaveText([EVENTS.furmeet.title]);
  await expect(page.locator('#rsvpEmpty')).toBeHidden();

  // Notifications: the stored choices, and push offered on this device.
  await expect(page.locator('#prefUpdates')).toBeChecked();
  await expect(page.locator('#prefReminders')).toBeChecked();
  await expect(page.locator('#prefNewEvents')).not.toBeChecked();
  await expect(page.locator('#pushState')).toHaveText('Notifications are off for this device.');
  await expect(page.locator('#pushOn')).toBeVisible();
  await expect(page.locator('#notifyTelegramBox')).toBeHidden();

  // Security.
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
});
