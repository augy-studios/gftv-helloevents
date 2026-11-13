// The forgotten-password page. Since help desk #18 (job 01) an unknown name
// and a staff account's name get the same single "not found" message, and
// the same answer from the server, so the page never says which names are
// staff.

import { test, expect } from './fixtures.js';
import { MEMBER, STAFF } from './seed.js';
import { TURNSTILE_TEST_SITE_KEY } from './stubs.js';

const NOT_FOUND = 'We could not start a reset for that account. If you are GFTV staff, reset your password on gftv.asia.';

// Sends the first step for a name and returns the server's answer.
async function startReset(page, identifier) {
  await page.locator('#identifier').fill(identifier);
  const answer = page.waitForResponse((response) => response.url().endsWith('/api/auth/recover'));
  await page.locator('#startSubmit').click();
  return (await answer).json();
}

test('the reset page shows one "not found" message for an unknown name and for a staff name', async ({ page, serverState }) => {
  await page.goto('/reset');
  await expect(page.locator('#humanCheck')).toHaveAttribute('data-e2e-turnstile', TURNSTILE_TEST_SITE_KEY);
  const notFound = page.locator('#notFound');
  await expect(notFound).toBeHidden();

  expect(await startReset(page, 'nobody-by-this-name')).toEqual({ ok: true, found: false });
  await expect(notFound).toBeVisible();
  await expect(notFound).toHaveText(NOT_FOUND);
  await expect(page.locator('#startError')).toHaveText('');
  await expect(page.locator('#stepCode')).toBeHidden();

  // A staff account's name: exactly the same answer and message.
  expect(await startReset(page, STAFF.username)).toEqual({ ok: true, found: false });
  await expect(notFound).toBeVisible();
  await expect(notFound).toHaveText(NOT_FOUND);
  await expect(page.locator('#stepStart')).toBeVisible();
  await expect(page.locator('#stepCode')).toBeHidden();

  // A real public account goes on to the next step instead. This one has
  // neither Telegram nor 2FA, so the only way is a code from staff.
  const found = await startReset(page, MEMBER.username);
  expect(found.found).toBe(true);
  await expect(page.locator('#stepCode')).toBeVisible();
  await expect(page.locator('#stepStart')).toBeHidden();
  await expect(page.locator('#askStaff')).toBeVisible();
  await expect(page.locator('#wayPicker [data-way="staff-code"]')).toHaveAttribute('aria-pressed', 'true');

  // Each try sent a fresh Turnstile token for the "reset" action.
  const state = await serverState.read();
  expect(state.turnstile.map((check) => check.action)).toEqual(['reset', 'reset', 'reset']);
  expect(state.turnstile.every((check) => check.success)).toBe(true);
});
