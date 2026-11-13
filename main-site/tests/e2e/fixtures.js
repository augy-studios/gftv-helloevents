// The `test` every spec imports, with what each end-to-end test needs set up
// around it:
//
//   baseURL          the e2e server (server.js) on the port it printed,
//                    which playwright.config.js puts in E2E_PORT
//   serverState      before the test: a fresh, seeded database on the server;
//                    after it: no API answer carried a secret field, no
//                    handler tried to reach the network, nothing failed on
//                    the server. read() returns what the stubs saw so far.
//   stubbedRequests  every request to another origin (Google Analytics,
//                    Cloudflare Turnstile, anything else) is answered here
//                    with an empty body, or the Turnstile stub, so nothing
//                    reaches the network; the list of URLs it answered
//   page             the browser's clock frozen at FIXED_NOW (seed.js), and
//                    after the test: no console errors and no uncaught
//                    exceptions on any page it opened
//
// Plus the sign-in steps several tests share.

import { test as base, expect } from '@playwright/test';
import { totpAt } from '../../api/_lib/totp.js';
import { FIXED_NOW, PASSWORD, STAFF_TOTP_SECRET } from './seed.js';
import { TURNSTILE_SCRIPT } from './stubs.js';

export { expect };

export function serverOrigin() {
  const port = process.env.E2E_PORT;
  if (!port) {
    throw new Error('E2E_PORT is not set: run these with `npm run test:e2e`, which starts tests/e2e/server.js');
  }
  return `http://localhost:${port}`;
}

async function readState() {
  const response = await fetch(`${serverOrigin()}/__e2e__/state`);
  return response.json();
}

// The body type for a stubbed request, so the browser takes the empty answer
// quietly (an empty script runs, an empty stylesheet applies nothing).
function stubContentType(resourceType) {
  if (resourceType === 'script') {
    return 'text/javascript';
  }
  if (resourceType === 'stylesheet') {
    return 'text/css';
  }
  if (resourceType === 'fetch' || resourceType === 'xhr') {
    return 'application/json';
  }
  return 'text/plain';
}

export const test = base.extend({
  baseURL: async ({}, use) => {
    await use(serverOrigin());
  },

  serverState: [
    async ({}, use) => {
      const reset = await fetch(`${serverOrigin()}/__e2e__/reset`, { method: 'POST' });
      expect(reset.ok, 'the e2e server reset its database').toBe(true);
      await use({ read: readState });
      const state = await readState();
      expect(state.leaks, 'API answers carrying fields from SECRET_FIELDS').toEqual([]);
      expect(state.refusedFetches, 'handlers tried to reach the network').toEqual([]);
      expect(state.serverErrors, 'requests that failed on the e2e server').toEqual([]);
    },
    { auto: true },
  ],

  stubbedRequests: [
    async ({ context }, use) => {
      const origin = serverOrigin();
      const stubbed = [];
      await context.route(
        (url) => url.origin !== origin,
        async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          stubbed.push(request.url());
          if (url.hostname === 'challenges.cloudflare.com' && url.pathname.startsWith('/turnstile/')) {
            await route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_SCRIPT });
            return;
          }
          await route.fulfill({ status: 200, contentType: stubContentType(request.resourceType()), body: '' });
        }
      );
      await use(stubbed);
    },
    { auto: true },
  ],

  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const location = message.location();
        problems.push(`console error: ${message.text()} (${location.url}:${location.lineNumber})`);
      }
    });
    page.on('pageerror', (error) => {
      problems.push(`uncaught exception: ${error.message}`);
    });
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    await use(page);
    expect(problems, 'console errors and uncaught exceptions').toEqual([]);
  },
});

// ---------------------------------------------------------------------------
// Signing in through the sign-in page
// ---------------------------------------------------------------------------

// The password step on /login (the page must already be open). The page
// waits for its Turnstile widget first, as a person would.
export async function enterPassword(page, identifier, password = PASSWORD) {
  await expect(page.locator('#humanCheck')).toHaveAttribute('data-e2e-turnstile', /.+/);
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.locator('#passwordSubmit').click();
}

// A staff account: the password, then a code from the authenticator app
// (the shared secret from seed.js, at the real time the server checks).
export async function signInAsStaff(page, username) {
  await enterPassword(page, username);
  await expect(page.locator('#stepFactor')).toBeVisible();
  await expect(page.locator('#methodPicker [data-method="totp"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#code').fill(totpAt(STAFF_TOTP_SECRET));
  await page.locator('#codeSubmit').click();
}

// An account with 2FA, by one of its backup codes.
export async function signInWithBackupCode(page, username, backupCode) {
  await enterPassword(page, username);
  await expect(page.locator('#stepFactor')).toBeVisible();
  await page.locator('#methodPicker [data-method="backup"]').click();
  await page.locator('#code').fill(backupCode);
  await page.locator('#codeSubmit').click();
}
