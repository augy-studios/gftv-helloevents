// /helloid asking again instead of giving up: a clearer photo when the ID's
// machine-readable zone could not be read clearly (carrying on with the
// last photo allowed), the screen brightness confirmed before the face
// check, and the face part again with advice when it does not pass. The
// browser's camera is Chromium's fake one; HelloID's answers are stood in
// for, as they need the face models.

import { test, expect, serverOrigin, signInAsStaff } from './fixtures.js';
import { ADMIN } from './seed.js';

const fakeCamera = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const launchOptions = { args: fakeCamera };
// A local run against another Chromium (PW_CHROMIUM) keeps the fake camera.
if (process.env.PW_CHROMIUM) {
  launchOptions.executablePath = process.env.PW_CHROMIUM;
}
test.use({ launchOptions, permissions: ['camera'] });

const CHALLENGE = { token: 'challenge-token', turns: ['left', 'right', 'up', 'down'], flashes: ['red', 'green', 'blue', 'red', 'green', 'blue'], expiresInSeconds: 600 };
const SIGNED_IN = { ok: true, signedIn: true, user: { username: 'otter', displayName: 'Otter', avatarUrl: null, kind: 'public', role: 'member', canManage: false, editsEvents: false, country: 'SG', personal: { legalName: null, dateOfBirth: null, emergencyName: null, emergencyPhone: null }, idVerified: [], locale: 'en' } };
const STANDING = { verified: false, pending: false, latest: null, country: 'SG', personal: { legalName: null, dateOfBirth: null } };

test('an unclear ID is photographed again, and a face check that does not pass is done again with more brightness', async ({ page }) => {
  test.setTimeout(90_000);
  const reads = [];
  const submits = [];
  await page.route('**/api/auth/session', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(SIGNED_IN) }));
  await page.route('**/api/me/helloid**', async (route) => {
    const request = route.request();
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ...body }) });
    if (request.method() === 'GET') {
      if (request.url().includes('challenge=1')) {
        return json({ challenge: CHALLENGE });
      }
      return json({ helloid: STANDING });
    }
    const body = request.postDataJSON();
    if (body.action === 'read') {
      reads.push(body);
      return json({ read: null, zone: 'unclear' });
    }
    submits.push(body);
    if (submits.length === 1) {
      return json({ retry: { reason: 'flashes', tries: 1, of: 3, history: 'signed-history' } });
    }
    return json({ helloid: { ...STANDING, pending: true, latest: { status: 'pending', reason: null, failure: null } }, user: SIGNED_IN.user });
  });

  await page.goto('/helloid');
  await page.getByRole('button', { name: 'Passport', exact: true }).click();
  // Before the start: the brightness tip.
  await expect(page.locator('#brightnessTip')).toContainText('screen brightness all the way up');
  await page.locator('#consentBox').check();
  await page.locator('#consentNext').click();

  // The photo; the zone comes back unclear: asked for a clearer one.
  const shoot = page.locator('#docShoot');
  await expect(shoot).toBeVisible();
  await expect(page.locator('#captureRetake')).toBeHidden();
  await expect.poll(() => page.locator('#docVideo').evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
  await shoot.click();
  await page.locator('#docUse').click();
  await expect(page.locator('#captureRetake')).toBeVisible();
  await expect(page.locator('#captureRetake')).toContainText('could not read the lines');
  await expect(page.locator('#docSkip')).toBeVisible();
  expect(reads).toHaveLength(1);
  // Taken again, still unclear: asked once more; then they carry on.
  await expect.poll(() => page.locator('#docVideo').evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
  await shoot.click();
  await expect(page.locator('#docSkip')).toBeHidden();
  await page.locator('#docUse').click();
  await expect(page.locator('#captureRetake')).toBeVisible();
  expect(reads).toHaveLength(2);
  await page.locator('#docSkip').click();
  await expect(page.locator('#stepDetails')).toBeVisible();

  await page.locator('#detailsName').fill('Otter Tan');
  await page.locator('#detailsBirth').fill('1999-02-03');
  await page.locator('#detailsNext').click();

  // Headwear and glasses advice, and the face check waits for the brightness to be
  // confirmed.
  await expect(page.locator('#stepLive')).toContainText('Take off hats, caps and other headwear, and your glasses unless your ID photo shows you wearing them');
  const start = page.locator('#liveStart');
  await expect(start).toBeDisabled();
  await page.locator('#liveBright').check();
  await expect(start).toBeEnabled();
  await start.click();
  // The colour check does not pass: back to the face check, with advice,
  // the brightness to confirm again, and the ID photo kept.
  await expect(page.locator('#liveRetry')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#liveRetry')).toContainText('Turn your screen brightness up as far as it goes');
  await expect(page.locator('#liveRetry')).toContainText('2 more tries');
  await expect(page.locator('#liveBright')).not.toBeChecked();
  await expect(start).toBeDisabled();
  expect(submits[0].faceHistory).toBeUndefined();
  await page.locator('#liveBright').check();
  await start.click();
  await expect(page.locator('#resultTitle')).toHaveText('Almost there', { timeout: 40_000 });
  expect(submits[1].faceHistory).toBe('signed-history');
  expect(submits[1].front).toBe(submits[0].front);
});

test('an admin works out the HelloID tuning report on its own tab', async ({ page }) => {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, ADMIN.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.locator('#manageTabs').getByRole('tab', { name: 'HelloID tuning' }).click();
  await expect(page.locator('#tuningBox')).toBeVisible();
  await expect(page.locator('#idReviewsBox')).toBeHidden();
  await expect(page.locator('#tuningReport')).toBeEmpty();
  await page.locator('#tuningRun').click();
  // No decided checks yet: the settings as they are, nothing suggested, and
  // why not to trust it yet.
  const report = page.locator('#tuningReport');
  await expect(report).toContainText('0 approved by the checks, 0 approved by an admin, 0 declined by an admin; 0 face templates. Face model: faceres.');
  await expect(report.locator('tbody').first().locator('tr')).toHaveCount(5);
  await expect(report.locator('tbody').first().locator('tr').first()).toContainText('Face match (ID photo to live face)0.55-');
  await expect(report).toContainText('Only 0 approved checks (want 30 or more)');
  if (process.env.TUNING_SCREENSHOT) {
    await page.locator('#tuningBox').screenshot({ path: process.env.TUNING_SCREENSHOT });
  }
});
