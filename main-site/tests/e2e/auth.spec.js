// Making a public account at /signup, signing out, and signing in again at
// /login, with Turnstile drawn and checked on both forms.

import { test, expect, serverOrigin, enterPassword } from './fixtures.js';
import { TURNSTILE_TEST_SITE_KEY } from './stubs.js';

const NEW_ACCOUNT = {
  username: 'newpup',
  displayName: 'New Pup',
  email: 'newpup@example.org',
  password: 'a brand new password 42',
};

test('sign up for a public account, sign out, and sign in again with it', async ({ page, serverState }) => {
  await page.goto('/signup');
  await expect(page.locator('#humanCheck')).toHaveAttribute('data-e2e-turnstile', TURNSTILE_TEST_SITE_KEY);

  // Usernames are lowercase; the page fixes them as they are typed.
  await page.locator('#username').fill('NewPup');
  await expect(page.locator('#username')).toHaveValue(NEW_ACCOUNT.username);
  await page.locator('#displayName').fill(NEW_ACCOUNT.displayName);
  await page.locator('#email').fill(NEW_ACCOUNT.email);
  await page.locator('#password').fill(NEW_ACCOUNT.password);
  await page.locator('#agree').check();
  await page.locator('#signupSubmit').click();

  // Signed in straight away, on the account page.
  await page.waitForURL(`${serverOrigin()}/account`);
  await expect(page.locator('#accountView')).toBeVisible();
  await expect(page.locator('#displayName')).toHaveText(NEW_ACCOUNT.displayName);
  await expect(page.locator('#username')).toHaveText(NEW_ACCOUNT.username);
  await expect(page.locator('#role')).toHaveText('Member');
  await expect(page.locator('#rsvpEmpty')).toBeVisible();
  await expect(page.locator('#totpState')).toHaveText('Not set up.');

  await page.locator('#signOut').click();
  await page.waitForURL(`${serverOrigin()}/`);
  await expect(page.locator('header [data-when="signed-out"]')).toBeVisible();
  await expect(page.locator('header [data-when="signed-in"]')).toBeHidden();

  // Back in with the email address and the password; no second step, since
  // the new account has no 2FA.
  await page.locator('header [data-when="signed-out"]').click();
  await page.waitForURL(`${serverOrigin()}/login`);
  await enterPassword(page, NEW_ACCOUNT.email, NEW_ACCOUNT.password);
  await page.waitForURL(`${serverOrigin()}/`);
  await expect(page.locator('header [data-when="signed-in"]')).toBeVisible();
  await expect(page.locator('header [data-when="signed-out"]')).toBeHidden();
  await expect(page.locator('header [data-when="manager"]')).toBeHidden();

  // Both forms sent a Turnstile token made for their own action, and the
  // server checked it.
  const state = await serverState.read();
  expect(state.turnstile).toEqual([
    { action: 'signup', success: true, hostname: 'localhost' },
    { action: 'login', success: true, hostname: 'localhost' },
  ]);
});
