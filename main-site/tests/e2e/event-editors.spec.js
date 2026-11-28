// Editors of one event (migrations/018): an admin adds a member (who has
// two-step sign-in, by passkey) from the event's Organisers tab; the member
// then finds that event alone on /manage, with no New event, no staff tools,
// and the Status left to staff. And the organisers' Telegram chats
// (migrations/026) on the same tab.

import { test, expect, serverOrigin, signInAsStaff, signInWithBackupCode, openSection } from './fixtures.js';
import { ADMIN, EVENTS, PASSKEY_MEMBER, BACKUP_CODES } from './seed.js';

const event = EVENTS.convention;

test('an admin makes a member the editor of one event, and they edit it alone', async ({ page, context }) => {
  // The member signs in once, so they are active.
  await page.goto('/login?next=/account');
  await signInWithBackupCode(page, PASSKEY_MEMBER.username, BACKUP_CODES[0]);
  await page.waitForURL(`${serverOrigin()}/account`);
  await expect(page.locator('header [data-when="manager"]')).toBeHidden();
  // The account page loads its ID check section (and saves the language in
  // use) after it shows: let those requests finish before signing out, or
  // they come back 401 and the browser logs an error.
  await expect(page.locator('#accountView')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // The admin: the event's Organisers tab, picked from the active accounts.
  await context.clearCookies();
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, ADMIN.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#autosaveStatus')).toHaveText('All changes saved');
  await openSection(page, 'Organisers');
  await expect(page.locator('#eventEditorList')).toContainText('No editors of this event yet.');
  // Typing part of their name lists them; picking one fills the box.
  await page.locator('#eventEditorUsername').fill(PASSKEY_MEMBER.displayName.slice(0, 5));
  const option = page.locator('#eventEditorOptions .editor-option', { hasText: `@${PASSKEY_MEMBER.username}` });
  await expect(option).toBeVisible();
  await expect(page.locator('#eventEditorUsername')).toHaveAttribute('aria-expanded', 'true');
  await option.click();
  await expect(page.locator('#eventEditorUsername')).toHaveValue(PASSKEY_MEMBER.username);
  await expect(page.locator('#eventEditorOptions')).toBeHidden();
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
  await expect(page.locator('#tab-filter')).toBeHidden();
  await page.locator('#eventList .item-row .btn').click();
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

test('an admin sets the organiser chats of an event, checked as they are saved, and tests them', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, ADMIN.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(page.locator('#autosaveStatus')).toHaveText('All changes saved');
  await openSection(page, 'Organisers');
  const chats = page.locator('#organiserChats');
  await expect(chats).toHaveValue('');

  // Not a chat id: refused, naming it.
  await chats.fill('123456789, @organisers');
  await page.locator('#organiserChatsSave').click();
  await expect(page.locator('#organiserChatsError')).toHaveText('"@organisers" is not a Telegram chat ID. Use the number /chatid gives: a person\'s, or a group\'s, which starts with -.');

  // A person's id and a group's, once each.
  await chats.fill('123456789\n-1001234567890, 123456789');
  await page.locator('#organiserChatsSave').click();
  await expect(page.locator('#organiserChatsStatus')).toHaveText('Saved.');
  await expect(page.locator('#organiserChatsError')).toBeHidden();
  await expect(chats).toHaveValue('123456789\n-1001234567890');

  // Kept: back after a reload.
  await page.reload();
  await openSection(page, 'Organisers');
  await expect(chats).toHaveValue('123456789\n-1001234567890');

  // The test message: this server has no bot, so neither chat is reached.
  await page.locator('#organiserChatsTest').click();
  await expect(page.locator('#organiserChatsError')).toHaveText('Could not reach: 123456789, -1001234567890. Check that the bot is in the group, or that the person pressed Start in the bot.');
});
