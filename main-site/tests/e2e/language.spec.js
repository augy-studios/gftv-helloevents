// The language someone uses the site in is saved to their account
// (migrations/029, js/app.js), so the Telegram bot and the notices speak it
// too: picking one in the switcher saves it, and a browser that never picked
// one takes the account's.

import { test, expect, serverOrigin, signInWithBackupCode } from './fixtures.js';
import { PASSKEY_MEMBER, BACKUP_CODES } from './seed.js';

// The language the account has saved, as the session tells the page.
const savedLocale = (page) => page.evaluate(async () => {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
  const session = await response.json();
  return session.user.locale;
});

test('the language picked on the site is saved to the account, and a browser that never picked one follows it', async ({ page }) => {
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);
  await expect(page.locator('#accountView')).toBeVisible();

  // Nothing saved yet: the page saves the language it is in.
  await expect.poll(() => savedLocale(page)).toBe('en');

  // Picking Chinese saves it.
  await page.locator('.lang-btn').click();
  await page.locator('#langModal .lang-option[data-locale="zh-SG"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-SG');
  await expect.poll(() => savedLocale(page)).toBe('zh-SG');

  // A browser that never picked one (no stored choice; it detects English)
  // takes the account's instead of saving its own.
  await page.evaluate(() => localStorage.removeItem('locale'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-SG');
  await expect(page.getByRole('tab', { name: '安全设置' })).toBeVisible();
  expect(await savedLocale(page)).toBe('zh-SG');

  // Back to English from the switcher: saved again.
  await page.locator('.lang-btn').click();
  await page.locator('#langModal .lang-option[data-locale="en"]').click();
  await expect.poll(() => savedLocale(page)).toBe('en');
});
