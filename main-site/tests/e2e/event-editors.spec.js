// Editors of one event (migrations/018): an admin adds a member (who has
// two-step sign-in, by passkey) from the event's Editors tab; the member then
// finds that event alone on /manage, with no New event, no staff tools, and
// the Status left to staff.

import { test, expect, serverOrigin, signInAsStaff, signInWithBackupCode, openSection } from './fixtures.js';
import { ADMIN, EVENTS, PASSKEY_MEMBER, BACKUP_CODES } from './seed.js';

const event = EVENTS.convention;

test('an admin makes a member the editor of one event, and they edit it alone', async ({ page, context }) => {
  // The member signs in once, so they are active.
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);
  await expect(page.locator('header [data-when="manager"]')).toBeHidden();

  // The admin: the event's Editors tab, picked from the active accounts.
  await context.clearCookies();
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, ADMIN.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#autosaveStatus')).toHaveText('All changes saved');
  await openSection(page, 'Editors');
  await expect(page.locator('#eventEditorList')).toContainText('No editors of this event yet.');
  await expect(page.locator(`#eventEditorCandidates option[value="${PASSKEY_MEMBER.username}"]`)).toHaveCount(1);
  await page.locator('#eventEditorUsername').fill(PASSKEY_MEMBER.username);
  await page.locator('#eventEditorAddBtn').click();
  const row = page.locator('#eventEditorList li', { hasText: PASSKEY_MEMBER.username });
  await expect(row).toContainText(PASSKEY_MEMBER.displayName);
  await expect(row.locator('.editor-no-two-step')).toHaveCount(0);

  // The member: Manage in the header, their event alone, the Status locked.
  await context.clearCookies();
  await page.goto('/login?next=/manage');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[1]);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await expect(page.locator('header [data-when="manager"]')).toBeVisible();
  await expect(page.locator('#listBox')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#eventList .item-title')).toHaveText([event.title]);
  await expect(page.locator('#newEvent')).toBeHidden();
  await expect(page.locator('#tab-signups')).toBeHidden();
  await page.locator('#eventList .item-row .btn').click();
  await openSection(page, 'Price and RSVP');
  await expect(page.locator('#f-status')).toBeDisabled();
  await expect(page.locator('#statusStaffOnly')).toBeVisible();
  await expect(page.locator('#etab-editors')).toBeHidden();
  await expect(page.locator('#editorDelete')).toBeHidden();
  // Their changes save.
  await openSection(page, 'Basics');
  await page.locator('#f-summary').fill('Three days of fun, run by our organisers.');
  await page.locator('#f-summary').blur();
  await expect(page.locator('#autosaveStatus')).toHaveText('All changes saved');
});
