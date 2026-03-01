import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for pgStack Studio E2E tests.
 *
 * Prerequisites:
 *   - docker compose up -d --build  (PG + proxy must be running)
 *   - Studio served at http://127.0.0.1:8080/studio/
 *
 * Run:
 *   cd tests/studio && npx playwright test
 *   cd tests/studio && npx playwright test --headed   (watch in browser)
 *   cd tests/studio && npx playwright test --debug    (step-through)
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:8080/studio/',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Expect docker compose to be already running -- no webServer needed
  webServer: undefined,
  outputDir: 'test-results',
});
