// End-to-end tests: `npm run test:e2e` (or `npx playwright test`).
//
// Playwright starts tests/e2e/server.js, which serves this folder the way
// Vercel does and runs the real API handlers against the in-memory database
// and Redis that `npm test` uses. The server picks a free port and prints it;
// Playwright reads it into E2E_PORT, so several suites can run on one
// machine at once. The tests share one server and one database, which each
// test resets before it starts, so they run one at a time.
//
// Chromium only, headless, offline (tests/e2e/fixtures.js answers every
// request to another site), with a fixed window size, language and time zone,
// and the browser's clock frozen. Uses the Chromium that @playwright/test
// 1.65.0 expects (revision 1254); `npx playwright install chromium` fetches
// it on a machine that has none.

import { defineConfig } from '@playwright/test';
import { TIME_ZONE } from './tests/e2e/seed.js';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // Traces and screenshots of failed tests. tests/ is skipped by
  // check-i18n and left out of deploys by .vercelignore.
  outputDir: './tests/e2e/output',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'en-SG',
    timezoneId: TIME_ZONE,
    colorScheme: 'light',
    // The update bar registers sw.js on every page; no test needs it, and a
    // worker would cache pages between tests.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/server.js',
    wait: { stdout: /e2e server listening on http:\/\/localhost:(?<e2e_port>\d+)/ },
    reuseExistingServer: false,
    timeout: 30_000,
    stderr: 'pipe',
  },
});
